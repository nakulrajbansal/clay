// The DB worker (doc 02 §1/§3): exclusively owns SQLite over OPFS and hosts
// the trusted kernel — ClayStore, Validator, and the MutationPipeline all
// run here. The main thread gets: a command protocol (below) plus
// serveStore RPC ports for the Bridge's AsyncStore (live and shadow).
// Records never leave this worker except over those ports to the Bridge.
import type {
  CheckpointObservation, DebugEvent, DeviceStateResult, LivePanel, PanelProvenance,
  PreparedMutationPreview, TargetIdentityV1,
} from "@clay/kernel";
import {
  deriveDeviceState, projectDailyHome, resolveDailyRelativeDate, targetIdentityEquals,
} from "@clay/kernel";
import { portFromMessagePort, serveStore } from "@clay/kernel/worker-rpc";
import type { StoreServerControl } from "@clay/kernel/worker-rpc";
import {
  projectPlaintextV1Cooperative, projectionTransportV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
import { ClayError } from "@clay/kernel/errors";
import type {
  ExistingTableImportMapping, ExistingTableImportMode, ImportHeaderChoice,
  ImportParserChunk, ImportSourceDescriptor,
} from "@clay/kernel/import-staging-contracts";
import type {
  ProductionStoreAuthority,
  ProductionStoreReader,
} from "@clay/kernel/worker-authority";
import type {
  Planner, PlannerContext, PlannerResult,
} from "@clay/kernel/planner-pipeline";
import { createStarterSeedBundle } from "../shells/seed";
import { parseSampleProvenanceLedger } from "../shells/sample-provenance";
import {
  applyFirstSuccessEvent,
  emptyFirstSuccessState,
  parseFirstSuccessState,
} from "../app/first-success-state";
import { createSampleFillBundle } from "./samples";
import { DB_WORKER_ROUTE_CENSUS } from "./mutation-route-census";
import type { ImportSessionCoordinator } from "./release-c/import-session-coordinator";

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

export type DeviceProtectionProjection = Readonly<{
  result: DeviceStateResult;
  target: TargetIdentityV1 | null;
  checkpoint: CheckpointObservation;
}>;

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
let importCoordinator: Promise<ImportSessionCoordinator> | null = null;
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
const cancelledProjections = new Set<number>();
type ProjectionOutcome = "cancelled" | "completed" | "failed";
type ProjectionLifecycle = {
  terminal: Promise<ProjectionOutcome>;
  resolve: (outcome: ProjectionOutcome) => void;
};
const projectionLifecycles = new Map<number, ProjectionLifecycle>();
const TRACE_CAP = 25;

function beginProjectionLifecycle(id: number): void {
  let resolve!: (outcome: ProjectionOutcome) => void;
  const terminal = new Promise<ProjectionOutcome>(done => { resolve = done; });
  projectionLifecycles.set(id, { terminal, resolve });
}

function finishProjectionLifecycle(id: number, outcome: ProjectionOutcome): void {
  const lifecycle = projectionLifecycles.get(id);
  projectionLifecycles.delete(id);
  lifecycle?.resolve(outcome);
}

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

function mustImportCoordinator(): Promise<ImportSessionCoordinator> {
  return importCoordinator ??= import("./release-c/import-session-coordinator")
    .then(({ ImportSessionCoordinator: Coordinator }) => new Coordinator(mustAuthority()));
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
    | "commitImport" | "undoImport"
    | "upsertAutomation" | "saveAutomationDraft" | "saveAutomationRecipeDraft"
    | "enableAutomation" | "pauseAutomation" | "deleteAutomation" | "runAutomations" | "runAutomationNow"
    | "undoAutomationRun" | "markNotificationRead" | "recordPrivateMetric"
    | "setPrivateMetricsEnabled" | "clearPrivateMetrics" | "recordFilter"
    | "acceptSuggestion" | "dismissSuggestion"
    | "setCheckpoint" | "makeLatest" | "revertPanel" | "renamePanel" | "removePanel"
    | "addColumn" | "addRelationColumn" | "renameColumn"
    | "saveIntakeForm" | "markIntakeFormPublished" | "revokeIntakeForm" | "markIntakeFormExpired"
    | "stageIntakeSubmission" | "recordIntakeDeliveryFailure"
    | "authorizeIntakeDeliveryDiscard" | "resolveIntakeDeliveryFailure"
    | "rejectIntakeSubmission" | "simulateIntakeAutoAccept"
    | "enableIntakeAutoAccept" | "disableIntakeAutoAccept" | "processIntakeAutoAccept"
    | "acceptIntakeSubmission" | "undoIntakeReceipt",
  payload: unknown,
  req: Request,
): Promise<unknown> {
  const target = mustAuthority();
  const requestId = authorityRequestId(req);
  if (route === "commitImport") {
    const record = payload as Record<string, unknown>;
    return (await mustImportCoordinator()).commitImport({
      sessionId: String(record.sessionId),
      previewId: String(record.previewId),
      previewDigest: String(record.previewDigest),
      idempotencyKey: String(record.idempotencyKey),
    });
  }
  if (route === "undoImport") {
    const record = payload as Record<string, unknown>;
    return (await mustImportCoordinator()).undoImport(String(record.id), requestId);
  }
  const intakeRoutes = {
    saveIntakeForm: "intake.saveForm",
    markIntakeFormPublished: "intake.markPublished",
    revokeIntakeForm: "intake.revokeForm",
    markIntakeFormExpired: "intake.markExpired",
    stageIntakeSubmission: "intake.stageSubmission",
    recordIntakeDeliveryFailure: "intake.recordDeliveryFailure",
    authorizeIntakeDeliveryDiscard: "intake.authorizeDeliveryDiscard",
    resolveIntakeDeliveryFailure: "intake.resolveDeliveryFailure",
    rejectIntakeSubmission: "intake.rejectSubmission",
    simulateIntakeAutoAccept: "intake.simulateAutoAccept",
    enableIntakeAutoAccept: "intake.enableAutoAccept",
    disableIntakeAutoAccept: "intake.disableAutoAccept",
    processIntakeAutoAccept: "intake.processAutoAccept",
    acceptIntakeSubmission: "intake.acceptSubmission",
    undoIntakeReceipt: "intake.undoReceipt",
  } as const;
  if (route in intakeRoutes) return (await target.executeMutation({
    requestId,
    route: intakeRoutes[route as keyof typeof intakeRoutes],
    payload,
  })).result;
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
  if (route === "saveAutomationDraft") return (await target.executeMutation({
    requestId, route, payload: {
      input: fields.input,
      expectedRevision: fields.expectedRevision ?? null,
    },
  })).result;
  if (route === "saveAutomationRecipeDraft") return (await target.executeMutation({
    requestId, route, payload: { request: fields.request },
  })).result;
  if (route === "enableAutomation") return (await target.executeMutation({
    requestId, route, payload: {
      id: fields.id,
      expectedRevision: fields.expectedRevision,
      simulation: fields.simulation,
    },
  })).result;
  if (route === "pauseAutomation") return (await target.executeMutation({
    requestId, route, payload: { id: fields.id, expectedRevision: fields.expectedRevision },
  })).result;
  if (route === "runAutomationNow") return (await target.executeMutation({
    requestId, route, payload: {
      id: fields.id,
      expectedRevision: fields.expectedRevision,
      simulation: fields.simulation,
    },
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

const SAMPLE_PROVENANCE_SETTING = "sample_provenance_v1";
const LEGACY_SAMPLE_ROWS_SETTING = "sample_rows";

type ActiveSampleCoordinate = Readonly<{ table: string; rowId: string }>;

function activeSampleCoordinates(reader: ProductionStoreReader): readonly ActiveSampleCoordinate[] {
  if (reader.getSetting(LEGACY_SAMPLE_ROWS_SETTING) !== undefined)
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "legacy sample provenance is unauthenticated");
  const ledger = parseSampleProvenanceLedger(reader.getSetting(SAMPLE_PROVENANCE_SETTING));
  const byId = new Map<string, { name: string; active: boolean }>();
  for (const table of reader.registrySnapshot().values()) {
    const tableId = table.semantic?.tableId;
    if (!tableId) continue;
    if (byId.has(tableId))
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "sample table identity is ambiguous");
    byId.set(tableId, { name: table.name, active: !table.inactive });
  }
  const active: ActiveSampleCoordinate[] = [];
  for (const entry of ledger.entries) {
    const table = byId.get(entry.tableId);
    if (!table) continue;
    const row = reader.query({
      from: table.name,
      where: [{ field: "id", op: "eq", value: entry.rowId }],
      includeDeleted: true,
      limit: 1,
    })[0];
    if (table.active && row?.deleted_at == null)
      active.push(Object.freeze({ table: table.name, rowId: entry.rowId }));
  }
  return Object.freeze(active);
}

function firstRunEvidence(): Readonly<{
  sampleCount: number; sampleTables: string[]; realRecordCount: number; provenanceValid: boolean;
}> {
  const reader = mustStore();
  try {
    const samples = activeSampleCoordinates(reader);
    const sampleKeys = new Set(samples.map(item => JSON.stringify([item.table, item.rowId])));
    let realRecordCount = 0;
    for (const table of reader.registrySnapshot().values()) {
      if (table.inactive) continue;
      for (const row of reader.query({ from: table.name, limit: 500 })) {
        if (!sampleKeys.has(JSON.stringify([table.name, String(row.id)]))) realRecordCount++;
      }
    }
    return Object.freeze({
      sampleCount: samples.length,
      sampleTables: [...new Set(samples.map(item => item.table))].sort(),
      realRecordCount,
      provenanceValid: true,
    });
  } catch {
    return Object.freeze({
      sampleCount: 0,
      sampleTables: [],
      realRecordCount: 0,
      provenanceValid: false,
    });
  }
}

function firstEverydayActionTarget(): ActiveSampleCoordinate | null {
  const reader = mustStore();
  const samples = new Set(activeSampleCoordinates(reader)
    .map(item => JSON.stringify([item.table, item.rowId])));
  for (const table of reader.registrySnapshot().values()) {
    if (table.inactive) continue;
    const row = reader.query({ from: table.name, limit: 500 })
      .find(candidate => !samples.has(JSON.stringify([table.name, String(candidate.id)])));
    if (row) return Object.freeze({ table: table.name, rowId: String(row.id) });
  }
  return null;
}

async function completeEverydayAction(req: Request, payload: Record<string, unknown>): Promise<unknown> {
  if (payload.action !== "open" || typeof payload.table !== "string"
      || typeof payload.rowId !== "string")
    throw new ClayError("E_VALIDATION", "Everyday-action evidence is invalid");
  const reader = mustStore();
  const row = reader.query({
    from: payload.table,
    where: [{ field: "id", op: "eq", value: payload.rowId }],
    limit: 1,
  })[0];
  if (!row || String(row.id) !== payload.rowId || row.deleted_at != null)
    throw new ClayError("E_VALIDATION", "Everyday action did not read back a canonical real record");
  const stored = reader.getSetting("release_a_first_success_v1");
  const current = stored === undefined || stored === null
    ? emptyFirstSuccessState() : parseFirstSuccessState(stored);
  const applied = applyFirstSuccessEvent(current, {
    type: "everyday_action", action: "open", changed: true, sample: false,
  });
  const next = { ...applied, revision: current.revision + 1 };
  const committed = await mustAuthority().executeMutation({
    requestId: authorityRequestId(req),
    route: "setting.compareAndSet",
    payload: { key: "release_a_first_success_v1", expectedRevision: current.revision, value: next },
  });
  return parseFirstSuccessState((committed.result as { current?: unknown }).current ?? next);
}

function targetIdentity(value: {
  appInstanceId: string; activeGenerationId: string; lineageEpoch: string;
  protectionRevision: string; stateSha256: string;
}): TargetIdentityV1 {
  return Object.freeze({
    appInstanceId: value.appInstanceId,
    activeGenerationId: value.activeGenerationId,
    lineageEpoch: value.lineageEpoch,
    stateRevision: value.protectionRevision,
    stateDigest: value.stateSha256,
  });
}

async function deviceProtection(): Promise<DeviceProtectionProjection> {
  const inspection = mustAuthority().inspectAuthority();
  const target = targetIdentity(inspection.target);
  const selected = inspection.catalog.entries.find(entry =>
    entry.appInstanceId === inspection.catalog.selectedAppInstanceId) ?? null;
  const selectedTarget = selected ? Object.freeze({
    appInstanceId: selected.appInstanceId,
    activeGenerationId: selected.activeGenerationId,
    lineageEpoch: selected.currentLineageEpoch,
    stateRevision: selected.currentProtectionRevision,
    stateDigest: selected.stateSha256,
  }) : null;
  const checkpoint: CheckpointObservation = targetIdentityEquals(selectedTarget, target)
    ? { state: "valid", target }
    : { state: "generation_not_selected", target };
  const result = deriveDeviceState({
    checksComplete: true,
    expectedStoreFailure: null,
    catalogReadable: true,
    catalogAppCount: inspection.catalog.entries.length,
    namespaceInventoryReadable: true,
    durableNamespaceCount: inspection.catalog.entries.length,
    jobInventoryReadable: true,
    pendingOperationCount: 0,
    capability: "supported",
    userChoice: null,
    storeOpen: "yes",
    transactionCertified: checkpoint.state === "valid",
    persisted: "unknown",
    target,
    checkpoint,
  });
  return Object.freeze({ result: Object.freeze(result), target, checkpoint: Object.freeze(checkpoint) });
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
    case "importTable":
      return failClosedMutation(req.op);
    case "beginImport":
      return (await mustImportCoordinator()).beginImport({
        descriptor: (p as Record<string, unknown>).descriptor as ImportSourceDescriptor,
        targetTable: String((p as Record<string, unknown>).targetTable),
        ...((p as Record<string, unknown>).sheetId === undefined
          ? {} : { sheetId: String((p as Record<string, unknown>).sheetId) }),
      });
    case "stageImportChunk":
      return (await mustImportCoordinator()).stageImportChunk({
        appInstanceId: String((p as Record<string, unknown>).appInstanceId),
        chunk: (p as Record<string, unknown>).chunk as ImportParserChunk,
      });
    case "importStructure":
      return (await mustImportCoordinator()).importStructure(
        String((p as Record<string, unknown>).sessionId),
        (p as Record<string, unknown>).header === undefined
          ? undefined : (p as Record<string, unknown>).header as ImportHeaderChoice,
      );
    case "configureImport":
      (await mustImportCoordinator()).configureImport({
        sessionId: String((p as Record<string, unknown>).sessionId),
        header: (p as Record<string, unknown>).header as ImportHeaderChoice,
        mode: (p as Record<string, unknown>).mode as ExistingTableImportMode,
        mappings: (p as Record<string, unknown>).mappings as ExistingTableImportMapping[],
      });
      return null;
    case "previewImport":
      return (await mustImportCoordinator()).previewImport(String((p as Record<string, unknown>).sessionId));
    case "commitImport":
      return runAuthorityMutation("commitImport", p, req);
    case "cancelImport":
      return (await mustImportCoordinator()).cancelImport(String((p as Record<string, unknown>).sessionId));
    case "undoImport":
      return runAuthorityMutation("undoImport", p, req);
    case "seed":
      return runAuthorityMutation("seed", createStarterSeedBundle(p.shellId), req);
    case "activateStarter": {
      await runAuthorityMutation("seed", {
        ...createStarterSeedBundle(p.shellId),
        activation: { operationId: p.operationId, appId: p.appId },
      }, req);
      const receipt = mustStore().getSetting("first_run_publication_v1");
      if (!receipt) throw new ClayError("E_INTERNAL", "starter publication receipt is missing");
      return receipt;
    }
    case "activateImportedApp":
      return failClosedMutation(req.op);
    case "firstRunPublication": {
      if (p.appId !== "default")
        throw new ClayError("E_VALIDATION", "first-run publication app binding is invalid");
      return mustStore().getSetting("first_run_publication_v1") ?? null;
    }
    case "undoFirstRunImport":
      return (await mustAuthority().executeMutation({
        requestId: authorityRequestId(req),
        route: "firstRun.undoImport",
        payload: p,
      })).result;
    case "firstRunEvidence":
      return firstRunEvidence();
    case "firstEverydayActionTarget":
      return firstEverydayActionTarget();
    case "completeEverydayAction":
      return completeEverydayAction(req, p);
    case "deviceProtection":
      return deviceProtection();
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
    case "projectPlaintextV1":
      try {
        const artifact = await projectPlaintextV1Cooperative(mustStore(), p as ProjectionRequestV1, {
          isCancelled: () => cancelledProjections.has(req.id),
        });
        return projectionTransportV1(artifact);
      } finally {
        cancelledProjections.delete(req.id);
      }
    case "cancelProjectionV1": {
      const targetId = Number(p.targetId);
      if (!Number.isSafeInteger(targetId) || targetId < 1)
        throw new ClayError("E_VALIDATION", "projection cancellation target is invalid");
      const lifecycle = projectionLifecycles.get(targetId);
      if (!lifecycle) return { targetId, quiescent: true, outcome: "not_found" };
      cancelledProjections.add(targetId);
      const outcome = await lifecycle.terminal;
      return { targetId, quiescent: true, outcome };
    }
    case "dailyHome": {
      const info = mustAuthority().bootInfo();
      const target = mustAuthority().inspectAuthority().target;
      const storedZone = mustStore().getSetting<unknown>("daily_time_zone_v1");
      const timeZone = typeof storedZone === "string"
        ? storedZone : typeof p.timeZone === "string" ? p.timeZone : null;
      if (timeZone === null)
        throw new Error("Daily Home calendar is not initialized");
      return projectDailyHome(mustStore(), {
        appInstanceId: info.selectedAppInstanceId,
        activeGenerationId: target.activeGenerationId,
        now: new Date(Date.now()).toISOString(),
        timeZone,
      });
    }
    case "dailyHomeResolveDate": {
      const storedZone = mustStore().getSetting<unknown>("daily_time_zone_v1");
      const timeZone = typeof storedZone === "string"
        ? storedZone : typeof p.timeZone === "string" ? p.timeZone : null;
      if (timeZone === null || typeof p.value !== "string")
        throw new Error("Daily Home calendar is not initialized");
      return resolveDailyRelativeDate(p.value, new Date(Date.now()).toISOString(), timeZone);
    }
    case "dailyHomeSourceCompareAndSet":
    case "dailyHomeNavigationCompareAndSet":
    case "dailyHomeInitializeTimeZone":
    case "dailyHomeQuickCapture":
    case "dailyHomeUndoCapture":
      return failClosedMutation(req.op);
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
    case "listIntakeForms":
      return mustStore().listIntakeForms();
    case "intakeInbox":
      return mustStore().intakeInbox();
    case "intakeDeliveryFailures":
      return mustStore().intakeDeliveryFailures();
    case "intakeReceipts":
      return mustStore().intakeReceipts();
    case "saveIntakeForm":
      return runAuthorityMutation("saveIntakeForm", p, req);
    case "markIntakeFormPublished":
      return runAuthorityMutation("markIntakeFormPublished", p, req);
    case "revokeIntakeForm":
      return runAuthorityMutation("revokeIntakeForm", p, req);
    case "markIntakeFormExpired":
      return runAuthorityMutation("markIntakeFormExpired", p, req);
    case "stageIntakeSubmission":
      return runAuthorityMutation("stageIntakeSubmission", p, req);
    case "recordIntakeDeliveryFailure":
      return runAuthorityMutation("recordIntakeDeliveryFailure", p, req);
    case "authorizeIntakeDeliveryDiscard":
      return runAuthorityMutation("authorizeIntakeDeliveryDiscard", p, req);
    case "resolveIntakeDeliveryFailure":
      return runAuthorityMutation("resolveIntakeDeliveryFailure", p, req);
    case "rejectIntakeSubmission":
      return runAuthorityMutation("rejectIntakeSubmission", p, req);
    case "simulateIntakeAutoAccept":
      return runAuthorityMutation("simulateIntakeAutoAccept", p, req);
    case "enableIntakeAutoAccept":
      return runAuthorityMutation("enableIntakeAutoAccept", p, req);
    case "disableIntakeAutoAccept":
      return runAuthorityMutation("disableIntakeAutoAccept", p, req);
    case "processIntakeAutoAccept":
      return runAuthorityMutation("processIntakeAutoAccept", p, req);
    case "acceptIntakeSubmission":
      return runAuthorityMutation("acceptIntakeSubmission", p, req);
    case "undoIntakeReceipt":
      return runAuthorityMutation("undoIntakeReceipt", p, req);
    case "automationRecipes":
      return mustStore().automationRecipes();
    case "automationRuntimeStatus":
      return mustStore().automationRuntimeStatus(mustAuthority().currentAutomationTarget());
    case "automationRuntimeOverview":
      return mustStore().automationRuntimeOverview(
        mustAuthority().currentAutomationTarget(), Number(p.limit ?? 100));
    case "listAutomations":
      return mustStore().listAutomations(mustAuthority().currentAutomationTarget());
    case "upsertAutomation":
      return runAuthorityMutation("upsertAutomation", p, req);
    case "saveAutomationDraft":
      return runAuthorityMutation("saveAutomationDraft", p, req);
    case "saveAutomationRecipeDraft":
      return runAuthorityMutation("saveAutomationRecipeDraft", p, req);
    case "enableAutomation":
      return runAuthorityMutation("enableAutomation", p, req);
    case "pauseAutomation":
      return runAuthorityMutation("pauseAutomation", p, req);
    case "deleteAutomation":
      return runAuthorityMutation("deleteAutomation", p, req);
    case "simulateAutomation":
      return mustAuthority().simulateAutomation({
        id: p.id,
        expectedRevision: p.expectedRevision,
        purpose: p.purpose,
      });
    case "runAutomations":
      return runAuthorityMutation("runAutomations", p, req);
    case "runAutomationNow":
      return runAuthorityMutation("runAutomationNow", p, req);
    case "automationRuns":
      return mustStore().automationRuns(
        mustAuthority().currentAutomationTarget(),
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
    case "backupSelection":
    case "backupRecords":
    case "prepareAutomaticBackup":
    case "validateBackupStage":
    case "publishBackup":
    case "backupTrustStatus":
    case "beginBackupTrustEnrollment":
    case "confirmBackupTrustEnrollment":
    case "importRecoveryKit":
    case "activateImportedBackupSeries":
    case "recoveryCandidates":
    case "validateRestoreArchive":
    case "restoreAsNew":
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
  const projectionRequest = req.op === "projectPlaintextV1";
  if (projectionRequest) beginProjectionLifecycle(req.id);
  void (async () => {
    let finishOperation = (): void => {};
    let projectionOutcome: ProjectionOutcome = "failed";
    try {
      if (req.op !== "shutdown") finishOperation = beginWorkerOperation();
      const result = await handle(req, ev.ports);
      const transfer: Transferable[] = [];
      const transferred = new Set<ArrayBuffer>();
      const addTransfer = (value: unknown): void => {
        const buffer = value instanceof ArrayBuffer ? value
          : value instanceof Uint8Array && value.buffer instanceof ArrayBuffer ? value.buffer : null;
        if (buffer && !transferred.has(buffer)) { transferred.add(buffer); transfer.push(buffer); }
      };
      if (result && typeof result === "object") {
        const bytes = result as { bytes?: unknown; plaintext?: unknown; csv?: unknown };
        addTransfer(bytes.bytes); addTransfer(bytes.plaintext); addTransfer(bytes.csv);
      }
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, result }, transfer);
      if (projectionRequest) projectionOutcome = "completed";
    } catch (e) {
      (self as unknown as Worker).postMessage({
        id: req.id, ok: false,
        error: {
          code: e instanceof ClayError ? e.code : "E_INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        },
      });
      if (projectionRequest && e instanceof ClayError && e.code === "E_CANCELLED")
        projectionOutcome = "cancelled";
    } finally {
      finishOperation();
      if (projectionRequest) finishProjectionLifecycle(req.id, projectionOutcome);
    }
  })();
};
