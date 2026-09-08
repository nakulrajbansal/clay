// Typed promise wrapper over the DB worker's command protocol.
import type {
  AttachmentFile, AttachmentMetadata, AttachmentStorageSummary,
  AutomationDefinition, AutomationDefinitionInput, AutomationRun, AutomationSimulation,
  BatchMutation, BatchReceipt, ClayNotification, DebugEvent, FieldProvenance,
  GlobalSearchResult,
  HistoryEntry, LivePanel, PanelProvenance,
  PrivateMetricEvent, PrivateMetricsSummary, RegTable, RelationConversionPreview,
  RelationFieldSpec,
  RelationConversionRequest, RelationConversionResult, SemanticSchemaTraceV1, Suggestion,
} from "@clay/kernel";
import {
  decodeProjectionTransportV1,
  type ProjectionArtifactV1,
  type ProjectionRequestV1,
  type ProjectionTransportV1,
} from "@clay/kernel/projection";
import { ClayError } from "@clay/kernel/errors";
import type { IntentOutcome } from "../worker/db-worker";
import { fetchModelHealth } from "./model-health";

export type TraceEntry = { at: string; intent: string; events: DebugEvent[] };

export type BootAppEntry = {
  id: string;
  name: string;
  shellId: string;
};

export type BootRequest = {
  requestedAppId: string | null;
  appCache: BootAppEntry[];
};

export type BootInfo = {
  persistent: boolean;
  seeded: boolean;
  shellId: string | null;
  selectedAppInstanceId: string;
  catalogGeneration: string;
  apps: BootAppEntry[];
};

const APP_ID = /^app_[a-z2-7]{26}$/;
const UINT64 = /^(?:0|[1-9][0-9]{0,19})$/;
const CACHE_ID = /^(?:default|[a-zA-Z0-9_-]{1,80})$/;

function parseAppEntry(value: unknown, canonical: boolean): BootAppEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid boot app entry");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 3
      || !Object.hasOwn(raw, "id") || !Object.hasOwn(raw, "name")
      || !Object.hasOwn(raw, "shellId")
      || typeof raw.id !== "string" || !(canonical ? APP_ID : CACHE_ID).test(raw.id)
      || typeof raw.name !== "string" || raw.name !== raw.name.trim()
      || raw.name.length < 1 || raw.name.length > 40
      || typeof raw.shellId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(raw.shellId))
    throw new Error("invalid boot app entry");
  return { id: raw.id, name: raw.name, shellId: raw.shellId };
}

function parseBootRequest(value: BootRequest): BootRequest {
  const requestedAppId = value.requestedAppId;
  if (requestedAppId !== null
      && (typeof requestedAppId !== "string" || !CACHE_ID.test(requestedAppId)))
    throw new Error("invalid boot request");
  if (!Array.isArray(value.appCache) || value.appCache.length > 1_000)
    throw new Error("invalid boot request");
  const appCache = value.appCache.map(entry => parseAppEntry(entry, false));
  if (new Set(appCache.map(entry => entry.id)).size !== appCache.length)
    throw new Error("invalid boot request");
  return { requestedAppId, appCache };
}

function parseBootInfo(value: unknown): BootInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid boot response");
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "persistent", "seeded", "shellId", "selectedAppInstanceId",
    "catalogGeneration", "apps",
  ]);
  if (Object.keys(raw).length !== allowed.size
      || Object.keys(raw).some(key => !allowed.has(key))
      || typeof raw.persistent !== "boolean" || typeof raw.seeded !== "boolean"
      || (raw.shellId !== null && typeof raw.shellId !== "string")
      || typeof raw.selectedAppInstanceId !== "string"
      || !APP_ID.test(raw.selectedAppInstanceId)
      || typeof raw.catalogGeneration !== "string" || !UINT64.test(raw.catalogGeneration)
      || !Array.isArray(raw.apps) || raw.apps.length < 1 || raw.apps.length > 1_000)
    throw new Error("invalid boot response");
  const apps = raw.apps.map(entry => parseAppEntry(entry, true));
  if (new Set(apps.map(entry => entry.id)).size !== apps.length
      || !apps.some(entry => entry.id === raw.selectedAppInstanceId))
    throw new Error("invalid boot response");
  return {
    persistent: raw.persistent,
    seeded: raw.seeded,
    shellId: raw.shellId as string | null,
    selectedAppInstanceId: raw.selectedAppInstanceId,
    catalogGeneration: raw.catalogGeneration,
    apps,
  };
}
export type StatusInfo = {
  persistent: boolean; persisted: boolean;
  usageBytes: number | null; quotaBytes: number | null;
  attachments: AttachmentStorageSummary;
  versions: number;
  stats: { kept: number; discarded: number; failed: number; clarify: number };
  modelConnection: {
    provider: string; model: string | null; configured: boolean;
    reachable: boolean; detail?: string;
  };
};

function mintWorkerRequestId(): string {
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
  return `req_${encoded}`;
}

export type ModelAccess = {
  provider: "clay" | "openai" | "anthropic" | "codex";
  apiKey: string | null;
  backendUrl: string | null;
  session: string | null;
  providerToken?: string | null;
  allowAmbientCredentials?: boolean;
};

const MODEL_SECRET_MAX = 8 * 1024;
const MODEL_ENDPOINT_MAX = 2 * 1024;

function captureModelAccess(value: unknown): Readonly<ModelAccess> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid model access");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("invalid model access");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const required = ["provider", "apiKey", "backendUrl", "session"] as const;
  const allowed = new Set<PropertyKey>([
    ...required, "providerToken", "allowAmbientCredentials",
  ]);
  if (keys.some(key => !allowed.has(key)) || required.some(key => !(key in descriptors)))
    throw new Error("invalid model access");
  const field = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("invalid model access");
    return descriptor.value;
  };
  const provider = field("provider");
  const apiKey = field("apiKey");
  const backendUrl = field("backendUrl");
  const session = field("session");
  const providerTokenDescriptor = descriptors.providerToken;
  const providerToken = providerTokenDescriptor ? field("providerToken") : undefined;
  const ambientDescriptor = descriptors.allowAmbientCredentials;
  const allowAmbientCredentials = ambientDescriptor
    ? field("allowAmbientCredentials") : false;
  const validSecret = (candidate: unknown): candidate is string | null | undefined =>
    candidate === null || candidate === undefined
      || (typeof candidate === "string" && candidate.length > 0
        && candidate.length <= MODEL_SECRET_MAX);
  if (!["clay", "openai", "anthropic", "codex"].includes(String(provider))
      || !validSecret(apiKey) || !validSecret(session) || !validSecret(providerToken)
      || typeof allowAmbientCredentials !== "boolean"
      || (backendUrl !== null && (typeof backendUrl !== "string"
        || backendUrl.length < 1 || backendUrl.length > MODEL_ENDPOINT_MAX)))
    throw new Error("invalid model access");
  return Object.freeze({
    provider: provider as ModelAccess["provider"],
    apiKey: provider === "anthropic" ? apiKey as string | null : null,
    backendUrl: provider === "anthropic" ? null : backendUrl as string | null,
    session: provider === "clay" ? session as string | null : null,
    allowAmbientCredentials: provider === "clay" && allowAmbientCredentials,
    ...(provider === "codex" ? { providerToken: providerToken ?? null } : {}),
  });
}

type PlannerBinding = {
  epoch: string; generation: number; contextId: string;
  attempt: 0 | 1; sequence: number;
};

const ESCAPE_SCAN_WORK_LIMIT = 16 * 1024 * 1024;

function containsProtectedSecret(text: string, access: Readonly<ModelAccess>): boolean {
  const secrets = [access.apiKey, access.session, access.providerToken]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
  if (secrets.length === 0) return false;
  let decoded = text;
  let scanned = 0;
  for (;;) {
    if (secrets.some(secret => decoded.includes(secret))) return true;
    scanned += decoded.length;
    if (scanned > ESCAPE_SCAN_WORK_LIMIT) return true;
    const collapsed = decoded.replace(/\\\\/g, "\\");
    const next = collapsed !== decoded ? collapsed : decoded
      .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\(["/bfnrt])/g, (_match, code: string) => ({
        "\"": "\"", "/": "/", b: "\b", f: "\f",
        n: "\n", r: "\r", t: "\t",
      })[code] ?? code);
    if (next === decoded) return false;
    decoded = next;
  }
}

type ActivePlanner = {
  port: MessagePort;
  controller: AbortController;
  accessGeneration: number;
  binding: PlannerBinding | null;
  closed: boolean;
  settled: Promise<void>;
  markSettled: () => void;
};

const WORKER_SHUTDOWN_TIMEOUT_MS = 2_000;

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

export class WorkerClient {
  #modelAccess: Readonly<ModelAccess> = Object.freeze({
    provider: "clay", apiKey: null, backendUrl: null, session: null,
    allowAmbientCredentials: false,
  });
  #terminated = false;
  #accepting = true;
  #lifecycle = 0;
  #modelAccessPreparationGeneration = 0;
  #modelAccessGeneration = 0;
  #shutdownPromise: Promise<void> | null = null;
  #activePlanners = new Set<ActivePlanner>();
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void;
  }>();

  constructor(private readonly worker: Worker) {
    worker.onmessage = (ev): void => {
      const msg = ev.data as {
        id: number; ok: boolean; result?: unknown;
        error?: string | { code?: string; message?: string };
      };
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      entry.cleanup();
      if (msg.ok) entry.resolve(msg.result);
      else if (typeof msg.error === "object" && msg.error !== null) entry.reject(new ClayError(
        (msg.error.code ?? "E_INTERNAL") as ClayError["code"],
        msg.error.message ?? "worker error",
      ));
      else entry.reject(new Error(msg.error ?? "worker error"));
    };
  }

  private call<T>(
    op: string,
    payload?: Record<string, unknown>,
    transfer?: Transferable[],
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#terminated) return Promise.reject(new Error("DB worker was terminated"));
    if (!this.#accepting && op !== "shutdown")
      return Promise.reject(new Error("DB worker shutdown is in progress"));
    if (signal?.aborted)
      return Promise.reject(new ClayError("E_CANCELLED", "The local export projection was cancelled."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", abort);
        const cancelId = this.nextId++;
        this.worker.postMessage({
          id: cancelId, requestId: mintWorkerRequestId(), op: "cancelProjectionV1",
          payload: { targetId: id },
        });
        reject(new ClayError("E_CANCELLED", "The local export projection was cancelled."));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, cleanup });
      try {
        signal?.addEventListener("abort", abort, { once: true });
        this.worker.postMessage({ id, requestId: mintWorkerRequestId(), op, payload }, transfer ?? []);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Terminate the worker, close every per-call planner port, and reject work
   * before a replacement worker can observe a stale model result. */
  shutdown(timeoutMs = WORKER_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.#terminated) return Promise.resolve();
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKER_SHUTDOWN_TIMEOUT_MS)
      return Promise.reject(new TypeError("worker shutdown timeout is invalid"));
    this.#accepting = false;
    this.#shutdownPromise = (async () => {
      const active = [...this.#activePlanners];
      for (const planner of active) {
        if (planner.binding && !planner.closed) {
          try { planner.port.postMessage({ v: 1, kind: "planner.cancel", ...planner.binding }); }
          catch { /* worker-side port may already be gone */ }
        }
        planner.controller.abort(new Error("worker shutdown requested"));
      }
      const plannersSettled = await settlesWithin(
        Promise.all(active.map(planner => planner.settled)), timeoutMs,
      );
      if (!plannersSettled || this.#terminated) {
        this.terminate();
        throw new Error("active planner did not settle before shutdown");
      }
      const acknowledged = await settlesWithin(this.call("shutdown"), timeoutMs);
      this.terminate();
      if (!acknowledged) throw new Error("worker did not acknowledge quiescent shutdown");
    })();
    return this.#shutdownPromise;
  }

  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#accepting = false;
    this.#lifecycle++;
    this.#modelAccessPreparationGeneration++;
    this.#modelAccessGeneration++;
    const error = new Error("DB worker was terminated");
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.pending.clear();
    for (const active of this.#activePlanners) {
      if (active.binding && !active.closed) {
        try { active.port.postMessage({ v: 1, kind: "planner.cancel", ...active.binding }); }
        catch { /* transferred worker may already be gone */ }
      }
      active.closed = true;
      active.controller.abort();
      active.port.close();
    }
    this.#activePlanners.clear();
    try { this.worker.terminate(); } catch { /* already gone */ }
  }

  async boot(request: BootRequest): Promise<BootInfo> {
    const captured = parseBootRequest(request);
    return parseBootInfo(await this.call<unknown>("boot", captured));
  }
  async setModelAccess(
    pendingAccess: ModelAccess | PromiseLike<ModelAccess>,
  ): Promise<boolean> {
    if (this.#terminated) throw new Error("DB worker was terminated");
    const generation = ++this.#modelAccessPreparationGeneration;
    this.#cancelPlannersForAccessChange(generation);
    const access = captureModelAccess(await pendingAccess);
    if (this.#terminated || generation !== this.#modelAccessPreparationGeneration) return false;
    this.#publishModelAccess(access, generation);
    return true;
  }

  revokeAccountSession(): void {
    if (this.#terminated) throw new Error("DB worker was terminated");
    const generation = ++this.#modelAccessPreparationGeneration;
    const current = this.#modelAccess;
    const access = Object.freeze({
      provider: current.provider,
      apiKey: current.apiKey,
      backendUrl: current.backendUrl,
      session: null,
      providerToken: current.providerToken,
      allowAmbientCredentials: false,
    });
    this.#publishModelAccess(access, generation);
  }

  #publishModelAccess(access: Readonly<ModelAccess>, generation: number): void {
    this.#modelAccess = access;
    this.#modelAccessGeneration = generation;
    this.#cancelPlannersForAccessChange(generation);
  }

  #cancelPlannersForAccessChange(generation: number): void {
    for (const active of this.#activePlanners) {
      if (active.closed || active.accessGeneration === generation) continue;
      active.controller.abort(new Error("model access changed"));
      if (!active.binding) continue;
      try { active.port.postMessage({ v: 1, kind: "planner.cancel", ...active.binding }); }
      catch { /* peer may already be gone */ }
      active.closed = true;
      active.port.close();
    }
  }

  async #modelConnection(access: Readonly<ModelAccess>): Promise<StatusInfo["modelConnection"]> {
    if (access.apiKey) return {
      provider: "anthropic", model: null, configured: true, reachable: true,
      detail: "API key stored on this device",
    };
    if (!access.backendUrl) return {
      provider: "none", model: null, configured: false, reachable: false,
      detail: "No model connection selected",
    };
    try {
      const response = await fetchModelHealth(
        `${access.backendUrl.replace(/\/$/, "")}/healthz`,
      );
      const health = response.value as {
        model?: boolean; provider?: string; model_id?: string;
        reachable?: boolean; detail?: string;
      };
      return {
        provider: typeof health.provider === "string" && health.provider.length <= 40
          ? health.provider : "hosted",
        model: typeof health.model_id === "string" && health.model_id.length <= 120
          ? health.model_id : null,
        configured: health.model === true,
        reachable: typeof health.reachable === "boolean" ? health.reachable : response.ok,
        detail: typeof health.detail === "string" && health.detail.length <= 300
          ? health.detail : (health.model ? "Connected" : "Backend reachable; model not configured"),
      };
    } catch {
      return { provider: "hosted", model: null, configured: true,
        reachable: false, detail: "Backend is not reachable" };
    }
  }

  #redactPlannerError(error: unknown, access: Readonly<ModelAccess>): {
    code: "E_NET" | "E_MODEL"; message: string;
  } {
    const candidate = typeof error === "object" && error !== null
      ? error as { code?: unknown; message?: unknown } : {};
    const code = candidate.code === "E_MODEL" ? "E_MODEL" : "E_NET";
    let message = typeof candidate.message === "string" ? candidate.message : String(error);
    if (containsProtectedSecret(message, access)) {
      message = "model request failed without transferable diagnostic";
    } else {
      for (const secret of [access.apiKey, access.session, access.providerToken]) {
        if (secret) message = message.replaceAll(secret, "[redacted]");
      }
    }
    return { code, message: message.slice(0, 512) };
  }

  #servePlanner(active: ActivePlanner, access: Readonly<ModelAccess>, lifecycle: number): void {
    let initial: { epoch: string; generation: number; contextId: string; contextJson: string } | null = null;
    let expectedSequence = 0;
    let busy = false;
    let finalized = false;
    const failClosed = (binding: PlannerBinding | null): void => {
      if (binding && !active.closed) {
        try { active.port.postMessage({ v: 1, kind: "planner.cancel", ...binding }); }
        catch { /* peer closed */ }
      }
      active.closed = true;
      active.controller.abort();
      active.port.close();
    };
    active.port.onmessage = event => {
      if (active.closed || this.#terminated || lifecycle !== this.#lifecycle) return;
      const message = event.data;
      const finalizeKeys = [
        "v", "kind", "epoch", "generation", "contextId", "sequence", "nonce",
      ] as const;
      if (exactRecord(message, finalizeKeys) && message.kind === "planner.finalize") {
        if (active.accessGeneration !== this.#modelAccessGeneration
            || finalized || busy || !initial || message.v !== 1
            || message.epoch !== initial.epoch || message.generation !== initial.generation
            || message.contextId !== initial.contextId || message.sequence !== expectedSequence
            || typeof message.nonce !== "string" || !/^fin_[a-z2-7]{26}$/.test(message.nonce)) {
          failClosed(active.binding);
          return;
        }
        finalized = true;
        active.port.postMessage({ v: 1, kind: "planner.finalized",
          epoch: initial.epoch, generation: initial.generation,
          contextId: initial.contextId, sequence: expectedSequence,
          nonce: message.nonce });
        return;
      }
      const keys = [
        "v", "kind", "epoch", "generation", "contextId", "attempt", "sequence",
        "context", "repair",
      ] as const;
      if (!exactRecord(message, keys)
          || message.v !== 1 || message.kind !== "planner.request"
          || typeof message.epoch !== "string" || !/^boot_[a-z2-7]{26}$/.test(message.epoch)
          || typeof message.generation !== "number" || !Number.isSafeInteger(message.generation)
          || message.generation < 1
          || typeof message.contextId !== "string" || !/^ctx_[a-z2-7]{26}$/.test(message.contextId)
          || (message.attempt !== 0 && message.attempt !== 1)
          || typeof message.sequence !== "number" || !Number.isSafeInteger(message.sequence)) {
        failClosed(null);
        return;
      }
      const binding: PlannerBinding = {
        epoch: message.epoch, generation: message.generation, contextId: message.contextId,
        attempt: message.attempt, sequence: message.sequence,
      };
      active.binding = binding;
      if (active.accessGeneration !== this.#modelAccessGeneration
          || finalized || busy || binding.sequence !== expectedSequence
          || binding.attempt !== expectedSequence
          || !exactRecord(message.context, ["registry", "panels", "recentSummaries", "intent"])
          || !Array.isArray(message.context.registry) || !Array.isArray(message.context.panels)
          || !Array.isArray(message.context.recentSummaries)
          || typeof message.context.intent !== "string") {
        failClosed(binding);
        return;
      }
      const contextJson = JSON.stringify(message.context);
      if (contextJson.length > 64 * 1024) { failClosed(binding); return; }
      if (binding.attempt === 0) {
        if (message.repair !== null || initial) { failClosed(binding); return; }
        initial = {
          epoch: binding.epoch, generation: binding.generation,
          contextId: binding.contextId, contextJson,
        };
      } else if (!initial
          || initial.epoch !== binding.epoch || initial.generation !== binding.generation
          || initial.contextId !== binding.contextId || initial.contextJson !== contextJson
          || !exactRecord(message.repair, ["priorRaw", "diagnostics"])
          || typeof message.repair.priorRaw !== "string"
          || message.repair.priorRaw.length > 64 * 1024
          || !Array.isArray(message.repair.diagnostics)
          || message.repair.diagnostics.length > 24
          || message.repair.diagnostics.some(value =>
            typeof value !== "string" || value.length > 512)) {
        failClosed(binding);
        return;
      }
      if (containsProtectedSecret(JSON.stringify({
        context: message.context, repair: message.repair,
      }), access)) {
        failClosed(binding);
        return;
      }
      busy = true;
      expectedSequence++;
      void (async () => {
        try {
          if (!access.apiKey && !access.backendUrl) throw Object.assign(
            new Error("No model connection. Add an API key or connect a backend in Settings."),
            { code: "E_MODEL" },
          );
          const { MutationClient } = await import("@clay/mutation/client");
          if (active.closed || this.#terminated || lifecycle !== this.#lifecycle) return;
          const transport = access.apiKey
            ? { mode: "byo" as const, apiKey: access.apiKey }
            : {
              mode: "hosted" as const,
              endpoint: access.backendUrl!,
              ...(access.allowAmbientCredentials ? { credentials: "include" as const } : {}),
              ...((access.provider === "clay" ? access.session : access.providerToken)
                ? { session: (access.provider === "clay" ? access.session : access.providerToken)! }
                : {}),
            };
          const client = new MutationClient(transport, {
            modelRepair: true, signal: active.controller.signal,
          });
          const context = message.context as never;
          const raw = binding.attempt === 0
            ? await client.rawPlan(context)
            : await client.rawRepair(
              context,
              (message.repair as { priorRaw: string }).priorRaw,
              (message.repair as { diagnostics: string[] }).diagnostics,
            );
          if (active.closed || this.#terminated || lifecycle !== this.#lifecycle) return;
          if (raw.length > 64 * 1024) throw Object.assign(
            new Error("model output exceeds the planner bridge limit"), { code: "E_MODEL" },
          );
          if (containsProtectedSecret(raw, access)) throw Object.assign(
            new Error("model response contained protected credential material"), { code: "E_MODEL" },
          );
          active.port.postMessage({
            v: 1, kind: "planner.response", ...binding,
            result: { ok: true, raw },
          });
        } catch (error) {
          if (active.closed || this.#terminated || lifecycle !== this.#lifecycle) return;
          active.port.postMessage({
            v: 1, kind: "planner.response", ...binding,
            result: { ok: false, error: this.#redactPlannerError(error, access) },
          });
        } finally {
          busy = false;
        }
      })();
    };
    active.port.onmessageerror = () => failClosed(active.binding);
    active.port.start();
  }

  async #plannerCall(op: "intent" | "repairPanel", payload: Record<string, unknown>): Promise<IntentOutcome> {
    if (this.#terminated) throw new Error("DB worker was terminated");
    if (!this.#accepting) throw new Error("DB worker shutdown is in progress");
    if (this.#modelAccessPreparationGeneration !== this.#modelAccessGeneration)
      throw new Error("model access update is in progress");
    const channel = new MessageChannel();
    let markSettled!: () => void;
    const settled = new Promise<void>(resolve => { markSettled = resolve; });
    const active: ActivePlanner = {
      port: channel.port1, controller: new AbortController(),
      accessGeneration: this.#modelAccessGeneration,
      binding: null, closed: false,
      settled, markSettled,
    };
    const access = Object.freeze({ ...this.#modelAccess });
    const lifecycle = this.#lifecycle;
    this.#activePlanners.add(active);
    this.#servePlanner(active, access, lifecycle);
    try {
      const outcome = await this.call<IntentOutcome>(op, payload, [channel.port2]);
      if (active.closed || this.#terminated || lifecycle !== this.#lifecycle
          || active.accessGeneration !== this.#modelAccessGeneration) {
        if (outcome?.status === "preview") {
          try { await this.call<null>("discard"); }
          catch (error) {
            this.terminate();
            throw new Error("stale planner preview could not be discarded", { cause: error });
          }
        }
        throw new Error("planner result became stale after model access changed");
      }
      return outcome;
    } finally {
      active.closed = true;
      active.controller.abort();
      active.port.close();
      this.#activePlanners.delete(active);
      active.markSettled();
    }
  }

  deleteApp(appId: string): Promise<null> { return this.call("deleteApp", { appId }); }
  forkApp(newAppId: string): Promise<null> { return this.call("forkApp", { newAppId }); }
  async status(): Promise<StatusInfo> {
    const access = Object.freeze({ ...this.#modelAccess });
    const status = await this.call<Omit<StatusInfo, "modelConnection">>("status");
    return { ...status, modelConnection: await this.#modelConnection(access) };
  }
  seed(shellId: string): Promise<null> { return this.call("seed", { shellId }); }
  importTable(payload: { table: string; columns: unknown[]; rows: unknown[] }):
    Promise<{ table: string; imported: number; columns: number }> {
    return this.call("importTable", payload);
  }
  panels(): Promise<LivePanel[]> { return this.call("panels"); }
  panelProvenance(): Promise<PanelProvenance[]> { return this.call("panelProvenance"); }
  semanticTrace(): Promise<SemanticSchemaTraceV1> { return this.call("semanticTrace"); }
  fieldProvenance(): Promise<FieldProvenance[]> { return this.call("fieldProvenance"); }
  recordPrivateMetric(event: PrivateMetricEvent): Promise<null> {
    return this.call("recordPrivateMetric", { event });
  }
  privateMetricsSummary(): Promise<PrivateMetricsSummary> {
    return this.call("privateMetricsSummary");
  }
  setPrivateMetricsEnabled(enabled: boolean): Promise<PrivateMetricsSummary> {
    return this.call("setPrivateMetricsEnabled", { enabled });
  }
  clearPrivateMetrics(): Promise<PrivateMetricsSummary> {
    return this.call("clearPrivateMetrics");
  }
  commitLayout(placements: { panel_id: string; region: "top" | "main" | "side"; order: number; w?: number; h?: number; col?: number | null }[]): Promise<LivePanel[]> {
    return this.call("commitLayout", { placements });
  }
  renamePanel(panelId: string, title: string): Promise<LivePanel[]> {
    return this.call("renamePanel", { panelId, title });
  }
  addAttachment(input: {
    table: string; rowId: string; field: string; name: string; mime: string; bytes: ArrayBuffer;
  }): Promise<AttachmentMetadata> {
    return this.call("addAttachment", input, [input.bytes]);
  }
  attachmentsForRecord(table: string, rowId: string, field: string): Promise<AttachmentMetadata[]> {
    return this.call("attachmentsForRecord", { table, rowId, field });
  }
  readAttachment(id: string): Promise<AttachmentFile> {
    return this.call("readAttachment", { id });
  }
  removeAttachment(table: string, rowId: string, field: string, id: string): Promise<null> {
    return this.call("removeAttachment", { table, rowId, field, id });
  }
  attachmentStorage(): Promise<AttachmentStorageSummary> {
    return this.call("attachmentStorage", {});
  }
  purgeDeletedAttachments(): Promise<{ files: number; bytes: number }> {
    return this.call("purgeDeletedAttachments", {});
  }
  listAutomations(): Promise<AutomationDefinition[]> {
    return this.call("listAutomations", {});
  }
  upsertAutomation(input: AutomationDefinitionInput): Promise<AutomationDefinition> {
    return this.call("upsertAutomation", { input });
  }
  deleteAutomation(id: string): Promise<null> {
    return this.call("deleteAutomation", { id });
  }
  simulateAutomation(id: string): Promise<AutomationSimulation> {
    return this.call("simulateAutomation", { id });
  }
  runAutomations(): Promise<AutomationRun[]> {
    return this.call("runAutomations", {});
  }
  runAutomationNow(id: string): Promise<AutomationRun> {
    return this.call("runAutomationNow", { id });
  }
  automationRuns(automationId?: string, limit = 100): Promise<AutomationRun[]> {
    return this.call("automationRuns", { automationId: automationId ?? null, limit });
  }
  undoAutomationRun(id: string): Promise<AutomationRun> {
    return this.call("undoAutomationRun", { id });
  }
  notifications(limit = 100): Promise<ClayNotification[]> {
    return this.call("notifications", { limit });
  }
  markNotificationRead(id: string): Promise<null> {
    return this.call("markNotificationRead", { id });
  }
  globalSearch(term: string, limit = 20): Promise<GlobalSearchResult[]> {
    return this.call("globalSearch", { term, limit });
  }
  applyBatch(summary: string, mutations: BatchMutation[]): Promise<BatchReceipt> {
    return this.call("applyBatch", { source: "user", summary, mutations });
  }
  operationBatches(limit = 50): Promise<BatchReceipt[]> {
    return this.call("operationBatches", { limit });
  }
  undoBatch(id: string): Promise<BatchReceipt> {
    return this.call("undoBatch", { id });
  }
  rowHistory(table: string, id: string):
    Promise<{ at: string; values: Record<string, unknown> }[]> {
    return this.call("rowHistory", { table, id });
  }
  previewRelationConversion(input: RelationConversionRequest): Promise<RelationConversionPreview> {
    return this.call("previewRelationConversion", input);
  }
  convertTextToRelation(
    input: RelationConversionPreview & { cardinality: "one" },
  ): Promise<RelationConversionResult> {
    return this.call("convertTextToRelation", input);
  }
  addColumn(table: string, column: { name: string; type: string } & Record<string, unknown>):
    Promise<RegTable[]> {
    return this.call("addColumn", { table, column });
  }
  addRelationColumn(
    table: string,
    column: { name: string; type: "relation"; relation: RelationFieldSpec } & Record<string, unknown>,
  ): Promise<RegTable[]> {
    return this.call("addRelationColumn", { table, column });
  }
  renameColumn(table: string, from: string, to: string): Promise<RegTable[]> {
    return this.call("renameColumn", { table, from, to });
  }
  removeColumn(table: string, column: string): Promise<RegTable[]> {
    return this.call("removeColumn", { table, column });
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
  intent(text: string): Promise<IntentOutcome> {
    if (typeof text !== "string" || containsProtectedSecret(text, this.#modelAccess))
      return Promise.reject(new ClayError(
        "E_VALIDATION", "Intent cannot contain active credential material",
      ));
    return this.#plannerCall("intent", { text });
  }
  repairPanel(panelId: string, _error: string): Promise<IntentOutcome> {
    return this.#plannerCall("repairPanel", { panelId });
  }
  revertPanel(panelId: string): Promise<LivePanel[]> {
    return this.call("revertPanel", { panelId });
  }
  keep(): Promise<{ version: number }> { return this.call("keep"); }
  discard(): Promise<null> { return this.call("discard"); }
  removeSamples(): Promise<{
    affected: number;
    recovery: { kind: "soft_delete"; recoverable: number };
  }> { return this.call("removeSamples", {}); }
  fillSamples(): Promise<{ added: number; tables: number }> { return this.call("fillSamples"); }
  sampleCount(): Promise<number> { return this.call("sampleCount"); }
  reset(): Promise<null> { return this.call("reset"); }
  registryTables(): Promise<RegTable[]> { return this.call("registryTables"); }
  async projectExport(
    request: ProjectionRequestV1, signal?: AbortSignal,
  ): Promise<ProjectionArtifactV1> {
    const transported = await this.call<ProjectionTransportV1>(
      "projectPlaintextV1", request, undefined, signal,
    );
    const canonicalProjection = decodeProjectionTransportV1(transported);
    return Object.freeze({
      projection: canonicalProjection,
      plaintext: transported.plaintext,
      csv: transported.csv,
    });
  }
  restoreRow(table: string, id: string): Promise<Record<string, unknown>> {
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
  deleteSetting(key: string): Promise<null> { return this.call("deleteSetting", { key }); }
  compareAndSetSetting<T>(
    key: string, expectedRevision: number, value: T,
  ): Promise<{ ok: boolean; current: unknown }> {
    return this.call("compareAndSetSetting", { key, expectedRevision, value });
  }

  /** Open a serveStore RPC port on the worker for the Bridge's AsyncStore. */
  openStorePort(target: "live" | "shadow"): MessagePort {
    if (!this.#accepting) throw new Error("DB worker shutdown is in progress");
    const channel = new MessageChannel();
    void this.call("storePort", { target }, [channel.port2]);
    channel.port1.start();
    return channel.port1;
  }
}
