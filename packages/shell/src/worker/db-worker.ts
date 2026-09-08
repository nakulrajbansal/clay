// The DB worker (doc 02 §1/§3): exclusively owns SQLite over OPFS and hosts
// the trusted kernel — ClayStore, Validator, and the MutationPipeline all
// run here. The main thread gets: a command protocol (below) plus
// serveStore RPC ports for the Bridge's AsyncStore (live and shadow).
// Records never leave this worker except over those ports to the Bridge.
import type {
  DebugEvent, LivePanel, PanelProvenance,
  PreparedMutationPreview,
} from "@clay/kernel";
import { portFromMessagePort, serveStore } from "@clay/kernel/worker-rpc";
import type { StoreServerControl } from "@clay/kernel/worker-rpc";
import { ClayError } from "@clay/kernel/errors";
import type {
  ProductionStoreAuthority,
  ProductionStoreReader,
} from "@clay/kernel/worker-authority";
import type {
  Planner, PlannerContext, PlannerResult,
} from "@clay/kernel/planner-pipeline";
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
  payload?: unknown;
};


let authority: ProductionStoreAuthority | null = null;
type WorkerBootProjection = {
  persistent: true; seeded: boolean; shellId: string | null;
  selectedAppInstanceId: string; catalogGeneration: string;
  apps: Array<{ id: string; name: string; shellId: string }>;
};
type AuthorityBoot = Readonly<{
  key: string;
  promise: Promise<WorkerBootProjection>;
}>;
let authorityBoot: AuthorityBoot | null = null;
let openedBootAliases: ReadonlySet<string> | null = null;
let store: ProductionStoreReader | null = null;
let persistent = false;
type PendingPreview = {
  preview: PreparedMutationPreview;
  decision: "open" | "keeping" | "discarding";
};
let pending: PendingPreview | null = null;
let pipelineRun: Promise<IntentOutcome> | null = null;
let shuttingDown = false;
let shutdownRun: Promise<null> | null = null;
let activeOperations = 0;
let storeAdmissionClosed = false;
const idleWaiters = new Set<() => void>();
const storePorts = new Set<MessagePort>();
const storeServers = new Set<StoreServerControl>();

function beginCountedOperation(closed: boolean): () => void {
  if (closed)
    throw new ClayError("E_CONFLICT", "worker shutdown is already in progress");
  activeOperations++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeOperations--;
    if (activeOperations === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  };
}

function beginWorkerOperation(): () => void {
  return beginCountedOperation(shuttingDown);
}

function beginStoreOperation(): () => void {
  return beginCountedOperation(storeAdmissionClosed);
}

function waitForWorkerIdle(): Promise<void> {
  if (activeOperations === 0) return Promise.resolve();
  return new Promise(resolve => idleWaiters.add(resolve));
}

const PLANNER_RAW_CAP = 64 * 1024;
const PLANNER_DIAGNOSTIC_CAP = 24;
const PLANNER_DIAGNOSTIC_LENGTH = 512;
const PLANNER_BRIDGE_TIMEOUT_MS = 180_000;
const PLANNER_CONTEXT_CAP = 64 * 1024;

function mintPlannerId(prefix: "boot" | "ctx" | "fin"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (let index = 0; index < bytes.length && encoded.length < 26; index++) {
    value = (value << 8) | bytes[index]!;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  return `${prefix}_${encoded}`;
}

const plannerBootEpoch = mintPlannerId("boot");
let plannerGeneration = 0;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function freezePlannerValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezePlannerValue(nested);
    Object.freeze(value);
  }
  return value;
}

function capturePlannerContext(value: PlannerContext): PlannerContext {
  const captured = freezePlannerValue(structuredClone(value));
  if (JSON.stringify(captured).length > PLANNER_CONTEXT_CAP)
    throw new ClayError("E_VALIDATION", "planner context exceeds the closed bridge limit");
  return captured;
}

function boundedDiagnostics(values: string[]): string[] {
  return values.slice(0, PLANNER_DIAGNOSTIC_CAP)
    .map(value => String(value).slice(0, PLANNER_DIAGNOSTIC_LENGTH));
}

type PlannerBinding = {
  epoch: string; generation: number; contextId: string;
  attempt: 0 | 1; sequence: number;
};

type PendingPlannerRound = {
  binding: PlannerBinding;
  resolve: (result: PlannerResult) => void;
  reject: (error: Error) => void;
};

type PlannerFinalizeBinding = Pick<PlannerBinding,
  "epoch" | "generation" | "contextId" | "sequence"> & { nonce: string };
type PendingPlannerFinalize = {
  binding: PlannerFinalizeBinding;
  resolve: () => void;
  reject: (error: Error) => void;
};

function bridgePlanner(
  port: MessagePort,
  generation: number,
  decodeRaw: (raw: string) => PlannerResult,
): Readonly<{ planner: Planner; finalize: () => Promise<void> }> {
  let context: PlannerContext | null = null;
  let contextId: string | null = null;
  let pendingRound: PendingPlannerRound | null = null;
  let pendingFinalize: PendingPlannerFinalize | null = null;
  let poison: Error | null = null;
  let nextSequence = 0;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const fail = (message: string): Error =>
    new ClayError("E_VALIDATION", `planner bridge rejected: ${message}`);
  const clearWatchdog = (): void => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  const rejectBridge = (error: Error): void => {
    clearWatchdog();
    poison ??= error;
    const waiting = pendingRound;
    const finalizing = pendingFinalize;
    pendingRound = null;
    pendingFinalize = null;
    waiting?.reject(error);
    finalizing?.reject(error);
  };
  const armWatchdog = (phase: "round" | "finalization"): void => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      rejectBridge(fail(`${phase} timed out`));
    }, PLANNER_BRIDGE_TIMEOUT_MS);
  };

  port.onmessage = event => {
    const message = event.data;
    if (pendingFinalize) {
      const waiting = pendingFinalize;
      const keys = ["v", "kind", "epoch", "generation", "contextId", "sequence", "nonce"] as const;
      const binding = waiting.binding;
      if (!exactRecord(message, keys) || message.v !== 1 || message.kind !== "planner.finalized"
          || message.epoch !== binding.epoch || message.generation !== binding.generation
          || message.contextId !== binding.contextId || message.sequence !== binding.sequence
          || message.nonce !== binding.nonce) {
        rejectBridge(fail("finalization binding does not match"));
        return;
      }
      pendingFinalize = null;
      clearWatchdog();
      waiting.resolve();
      return;
    }
    const waiting = pendingRound;
    if (!waiting) { rejectBridge(fail("late or duplicate response")); return; }
    const responseKeys = [
      "v", "kind", "epoch", "generation", "contextId", "attempt", "sequence", "result",
    ] as const;
    const cancelKeys = [
      "v", "kind", "epoch", "generation", "contextId", "attempt", "sequence",
    ] as const;
    const isCancel = exactRecord(message, cancelKeys) && message.kind === "planner.cancel";
    if (!isCancel && !exactRecord(message, responseKeys)) {
      rejectBridge(fail("message is not closed"));
      return;
    }
    const binding = waiting.binding;
    if (message.v !== 1
        || (message.kind !== "planner.response" && message.kind !== "planner.cancel")
        || message.epoch !== binding.epoch
        || message.generation !== binding.generation
        || message.contextId !== binding.contextId
        || message.attempt !== binding.attempt
        || message.sequence !== binding.sequence) {
      rejectBridge(fail("message binding does not match the active round"));
      return;
    }
    if (message.kind === "planner.cancel") {
      rejectBridge(fail("round was cancelled"));
      return;
    }
    const result = message.result;
    if (!exactRecord(result, ["ok", "raw"]) || result.ok !== true
        || typeof result.raw !== "string") {
      if (!exactRecord(result, ["ok", "error"]) || result.ok !== false) {
        rejectBridge(fail("terminal result is invalid"));
        return;
      }
      const plannerError = result.error;
      if (!exactRecord(plannerError, ["code", "message"])
          || typeof plannerError.code !== "string"
          || !["E_NET", "E_MODEL"].includes(plannerError.code)
          || typeof plannerError.message !== "string"
          || plannerError.message.length > PLANNER_DIAGNOSTIC_LENGTH) {
        rejectBridge(fail("terminal result is invalid"));
        return;
      }
      pendingRound = null;
      clearWatchdog();
      waiting.resolve({ ok: false, error: {
        code: plannerError.code,
        message: plannerError.message,
      } });
      return;
    }
    if (result.raw.length > PLANNER_RAW_CAP) {
      rejectBridge(fail("raw model output exceeds the bridge limit"));
      return;
    }
    try {
      const decoded = decodeRaw(result.raw);
      pendingRound = null;
      clearWatchdog();
      waiting.resolve(decoded);
    } catch (error) {
      rejectBridge(error instanceof Error ? error : fail("raw output could not be decoded"));
    }
  };
  port.onmessageerror = () => rejectBridge(fail("message could not be cloned"));
  port.start();

  const request = (
    suppliedContext: PlannerContext,
    attempt: 0 | 1,
    repair: null | { priorRaw: string; diagnostics: string[] },
  ): Promise<PlannerResult> => {
    if (poison) return Promise.reject(poison);
    if (pendingRound) return Promise.reject(fail("a round is already pending"));
    if (attempt === 0) {
      if (context) return Promise.reject(fail("first attempt was already requested"));
      context = capturePlannerContext(suppliedContext);
      contextId = mintPlannerId("ctx");
    } else if (!context || !contextId) {
      return Promise.reject(fail("repair was not authorized by a first attempt"));
    }
    if (repair && repair.priorRaw.length > PLANNER_RAW_CAP)
      return Promise.reject(fail("repair raw output exceeds the bridge limit"));
    const sequence = nextSequence++;
    const binding: PlannerBinding = {
      epoch: plannerBootEpoch, generation, contextId: contextId!, attempt, sequence,
    };
    const promise = new Promise<PlannerResult>((resolve, reject) => {
      pendingRound = { binding, resolve, reject };
    });
    armWatchdog("round");
    try {
      port.postMessage({
        v: 1, kind: "planner.request", ...binding, context,
        repair: repair ? {
          priorRaw: repair.priorRaw,
          diagnostics: boundedDiagnostics(repair.diagnostics),
        } : null,
      });
    } catch (error) {
      rejectBridge(error instanceof Error ? error : fail("request could not be posted"));
    }
    return promise;
  };

  const finalize = (): Promise<void> => {
    if (poison) return Promise.reject(poison);
    if (pendingRound || pendingFinalize || !contextId)
      return Promise.reject(fail("generation cannot finalize"));
    const binding: PlannerFinalizeBinding = {
      epoch: plannerBootEpoch, generation, contextId, sequence: nextSequence,
      nonce: mintPlannerId("fin"),
    };
    const promise = new Promise<void>((resolve, reject) => {
      pendingFinalize = { binding, resolve, reject };
    });
    armWatchdog("finalization");
    try {
      port.postMessage({ v: 1, kind: "planner.finalize", ...binding });
    } catch (error) {
      rejectBridge(error instanceof Error ? error : fail("finalization could not be posted"));
    }
    return promise;
  };
  return Object.freeze({
    planner: Object.freeze({
      requestPlan: (suppliedContext: PlannerContext) => request(suppliedContext, 0, null),
      requestRepair: (_suppliedContext: PlannerContext, priorRaw: string, failures: string[]) =>
        request(context ?? _suppliedContext, 1, { priorRaw, diagnostics: failures }),
    }),
    finalize,
  });
}

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

async function bootProductionAuthority(input: unknown): Promise<WorkerBootProjection> {
  const workerAuthority = await import("@clay/kernel/worker-authority");
  const captured = workerAuthority.captureBrowserBootInput(input);
  const key = JSON.stringify(captured);
  const project = (target: ProductionStoreAuthority): WorkerBootProjection => {
    const info = target.bootInfo();
    return Object.freeze({
      persistent: true as const,
      seeded: info.seeded,
      shellId: info.shellId,
      selectedAppInstanceId: info.selectedAppInstanceId,
      catalogGeneration: info.catalogGeneration,
      apps: info.apps.map(app => Object.freeze({ ...app })),
    });
  };
  if (authority) {
    const info = authority.bootInfo();
    if (captured.requestedAppId !== null
        && captured.requestedAppId !== info.selectedAppInstanceId
        && !openedBootAliases?.has(captured.requestedAppId))
      throw new ClayError("E_CATALOG_CONFLICT",
        "boot requested a different target than the opened worker authority");
    return project(authority);
  }
  if (authorityBoot) {
    if (authorityBoot.key !== key)
      throw new ClayError("E_CATALOG_CONFLICT",
        "concurrent boot request does not match the initializing target");
    return authorityBoot.promise;
  }
  const current = (async (): Promise<WorkerBootProjection> => {
    let candidate: ProductionStoreAuthority | null = null;
    try {
      candidate = await workerAuthority.ProductionStoreAuthority.bootBrowser(captured);
      await candidate.reconcileInterruptedPlannerAttempts();
      const candidateStore = candidate.readStore();
      const projection = project(candidate);
      authority = candidate;
      store = candidateStore;
      persistent = true;
      openedBootAliases = new Set([
        projection.selectedAppInstanceId,
        ...(captured.requestedAppId === null ? [] : [captured.requestedAppId]),
      ]);
      return projection;
    } catch (error) {
      if (candidate && authority !== candidate) {
        try { candidate.close(); } catch { /* candidate was never published */ }
      }
      throw error;
    }
  })();
  const inFlight = Object.freeze({ key, promise: current });
  authorityBoot = inFlight;
  try {
    return await current;
  } finally {
    if (authorityBoot === inFlight) authorityBoot = null;
  }
}

function authorityRequestId(req: Request): string {
  if (req.requestId === undefined)
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "worker request identity is required");
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
    | "seed" | "importTable" | "removeSamples" | "fillSamples"
    | "setSetting" | "deleteSetting" | "compareAndSetSetting" | "commitLayout"
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

async function executePipelineText(text: string, plannerPort: MessagePort): Promise<IntentOutcome> {
  if (pending)
    throw new ClayError("E_CONFLICT", "Finish the current preview before reshaping again");
  if (!text.trim() || text.length > 500)
    throw new ClayError("E_VALIDATION", "reshape intent must be 1–500 characters");
  if (!Number.isSafeInteger(plannerGeneration + 1))
    throw new ClayError("E_INTERNAL", "planner generation exhausted");
  const generation = ++plannerGeneration;

  // The DB worker retains pipeline, validation, shadow, and preview authority.
  // Only opaque model I/O crosses this one-intent port.
  const { MutationPipeline, decodePlannerRaw } =
    await import("@clay/kernel/planner-pipeline");
  const events: DebugEvent[] = [];
  const mutationAuthority = mustAuthority().plannerMutations();
  let deferredClarifyAttempt: string | null = null;
  const pipelineAuthority = Object.freeze({
    beginAttempt: (intent: string) => mutationAuthority.beginAttempt(intent),
    capturePlanningBase: () => mutationAuthority.capturePlanningBase(),
    preparePreview: (input: Parameters<typeof mutationAuthority.preparePreview>[0]) =>
      mutationAuthority.preparePreview(input),
    assertPlanningBase: (base: Parameters<typeof mutationAuthority.assertPlanningBase>[0]) =>
      mutationAuthority.assertPlanningBase(base),
    finalizeAttempt: async (
      attemptId: string, outcome: "clarify" | "failed", errorCode?: string,
    ): Promise<void> => {
      if (outcome === "clarify") {
        if (deferredClarifyAttempt !== null)
          throw new ClayError("E_INTERNAL", "clarification finalization was already deferred");
        deferredClarifyAttempt = attemptId;
        return;
      }
      await mutationAuthority.finalizeAttempt(attemptId, outcome, errorCode);
    },
    keep: (requestId: string, command: unknown) => mutationAuthority.keep(requestId, command),
    discard: (requestId: string, command: unknown) => mutationAuthority.discard(requestId, command),
  });
  const bridge = bridgePlanner(plannerPort, generation, decodePlannerRaw);
  const result = await new MutationPipeline(
    pipelineAuthority,
    bridge.planner,
    { onDebug: event => events.push(event) },
  ).run(text);
  try {
    await bridge.finalize();
  } catch (error) {
    if (result.status === "preview") {
      try { result.preview.shadow.close(); } catch { /* disposable cleanup cannot mask failure */ }
      await mutationAuthority.finalizeAttempt(result.attemptId, "failed", "E_VALIDATION");
    } else if (result.status === "clarify" && deferredClarifyAttempt === result.attemptId) {
      await mutationAuthority.finalizeAttempt(result.attemptId, "failed", "E_VALIDATION");
    }
    throw error;
  }
  if (result.status === "clarify") {
    if (deferredClarifyAttempt !== result.attemptId)
      throw new ClayError("E_INTERNAL", "clarification finalization binding is missing");
    await mutationAuthority.finalizeAttempt(result.attemptId, "clarify");
  }
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

async function runPipelineText(text: string, plannerPort: MessagePort): Promise<IntentOutcome> {
  if (pipelineRun)
    throw new ClayError("E_CONFLICT", "A reshape is already being prepared");
  const current = executePipelineText(text, plannerPort);
  pipelineRun = current;
  try {
    return await current;
  } finally {
    plannerPort.close();
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
  const currentAuthority = mustAuthority();
  if (!pending && req.requestId) {
    const version = await currentAuthority.replayPlannerDecision(req.requestId, "keep");
    if (typeof version !== "number")
      throw new ClayError("E_INTERNAL", "durable planner Keep result is invalid");
    return { version };
  }
  const planner = currentAuthority.plannerMutations();
  const current = openPendingPreview("keeping");
  const requestId = authorityRequestId(req);
  let version: number;
  try {
    version = await planner.keep(requestId, current.preview.command);
  } catch (error) {
    if (pending === current) current.decision = "open";
    throw error;
  }
  if (pending === current) pending = null;
  try { current.preview.shadow.close(); } catch { /* committed state is already terminal */ }
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist)
      persistent = await navigator.storage.persist();
  } catch { /* persistence request is best-effort */ }
  return { version };
}

async function discardPendingPreview(req: Request): Promise<null> {
  const currentAuthority = mustAuthority();
  if (!pending && req.requestId) {
    await currentAuthority.replayPlannerDecision(req.requestId, "discard");
    return null;
  }
  const planner = currentAuthority.plannerMutations();
  const current = openPendingPreview("discarding");
  const requestId = authorityRequestId(req);
  try {
    await planner.discard(requestId, current.preview.command);
  } catch (error) {
    if (pending === current) current.decision = "open";
    throw error;
  }
  if (pending === current) pending = null;
  try { current.preview.shadow.close(); } catch { /* discarded state is already terminal */ }
  return null;
}

function serveProductionStore(target: "live" | "shadow", port: MessagePort): void {
  const endpoint = target === "shadow"
    ? pending?.preview.shadow.asyncStore() ?? null
    : mustAuthority().asyncStore();
  if (!endpoint) throw new ClayError("E_CATALOG_UNAVAILABLE", "no shadow store is open");
  storePorts.add(port);
  port.start?.();
  storeServers.add(serveStore(endpoint, portFromMessagePort(port), beginStoreOperation));
}

function quiesceWorker(req: Request): Promise<null> {
  if (shutdownRun) return shutdownRun;
  shuttingDown = true;
  shutdownRun = (async () => {
    await Promise.all([...storeServers].map(server => server.quiesce()));
    storeAdmissionClosed = true;
    await waitForWorkerIdle();
    for (const port of storePorts) {
      try { port.close(); } catch { /* already closed */ }
    }
    storePorts.clear();
    storeServers.clear();
    let failure: unknown = null;
    try {
      if (pending) await discardPendingPreview(req);
    } catch (error) { failure = error; }
    try { authority?.close(); }
    catch (error) { failure ??= error; }
    authority = null;
    store = null;
    persistent = false;
    if (failure) throw failure;
    return null;
  })();
  return shutdownRun;
}

async function handle(req: Request, ports: readonly MessagePort[]): Promise<unknown> {
  enforceProductionMutationRoute(req.op);
  if (shuttingDown && req.op !== "shutdown")
    throw new ClayError("E_CONFLICT", "worker shutdown is already in progress");
  const payloadDescriptor = Reflect.getOwnPropertyDescriptor(req, "payload");
  const rawPayload = payloadDescriptor && "value" in payloadDescriptor
    ? payloadDescriptor.value : undefined;
  const p = (rawPayload ?? {}) as Record<string, unknown>;
  switch (req.op) {
    case "boot":
      // appId/localStorage is presentation-only. Durable selection and any
      // legacy adoption are derived by trusted worker inventory + catalog.
      return bootProductionAuthority(p);
    case "shutdown":
      return quiesceWorker(req);
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
    case "intent": {
      const port = ports[0];
      if (!port || ports.length !== 1)
        throw new ClayError("E_VALIDATION", "intent needs exactly one planner port");
      return runPipelineText(String(p.text ?? ""), port);
    }
    case "repairPanel": {
      const port = ports[0];
      if (!port || ports.length !== 1)
        throw new ClayError("E_VALIDATION", "panel repair needs exactly one planner port");
      const panelId = String(p.panelId ?? "");
      const panel = mustStore().livePanels().find(candidate => candidate.panel_id === panelId);
      if (!panel) throw new ClayError("E_VALIDATION", `unknown panel '${panelId}'`);
      return runPipelineText(
        `Repair panel "${panel.title}" (${panel.panel_id}) after a runtime error.`.slice(0, 500),
        port,
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
      return runAuthorityMutation("removeSamples", p, req);
    case "fillSamples":
      return runAuthorityMutation("fillSamples", createSampleFillBundle(mustStore()), req);
    case "sampleCount":
      return mustAuthority().sampleRowCount();
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
      return {
        persistent, persisted, usageBytes, quotaBytes,
        attachments: mustStore().attachmentStorage(),
        versions: mustStore().headVersion(),
        stats: mustStore().attemptStats(),
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
    let finishOperation = (): void => {};
    try {
      if (req.op !== "shutdown") finishOperation = beginWorkerOperation();
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
    } finally {
      finishOperation();
    }
  })();
};
