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
import type {
  ProductionBootInfo,
  ProductionRestoredAuthority,
  ProductionStoreAuthority,
  ProductionStoreReader,
} from "@clay/kernel/worker-authority";
import { createStarterSeedBundle } from "../shells/seed";
import { IndexedDbBackupTrustRecordStore } from "../app/backup-trust-store.browser";
import { BackupTrustRuntime } from "./backup-trust-runtime";
import { AutomaticBackupWorkerCoordinator } from "./automatic-backup";
import { RestoreAsNewWorkerCoordinator } from "./restore-as-new";
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
let backupTrust: BackupTrustRuntime | null = null;
let automaticBackup: AutomaticBackupWorkerCoordinator | null = null;
let restoreAsNew: RestoreAsNewWorkerCoordinator<ProductionRestoredAuthority> | null = null;
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

function mustBackupTrust(): BackupTrustRuntime {
  if (backupTrust) return backupTrust;
  if (!globalThis.indexedDB)
    throw new ClayError("E_CATALOG_UNAVAILABLE", "IndexedDB Backup Trust storage is unavailable");
  backupTrust = new BackupTrustRuntime(
    new IndexedDbBackupTrustRecordStore(globalThis.indexedDB),
  );
  return backupTrust;
}

function mustAutomaticBackup(): AutomaticBackupWorkerCoordinator {
  automaticBackup ??= new AutomaticBackupWorkerCoordinator(
    mustAuthority(), mustBackupTrust(),
  );
  return automaticBackup;
}

function mustRestoreAsNew(): RestoreAsNewWorkerCoordinator<ProductionRestoredAuthority> {
  restoreAsNew ??= new RestoreAsNewWorkerCoordinator(
    mustAuthority(), mustBackupTrust(),
  );
  return restoreAsNew;
}

function workerBootInfo(info: ProductionBootInfo): Omit<ProductionBootInfo, "adopted"> {
  return {
    persistent: info.persistent,
    seeded: info.seeded,
    shellId: info.shellId,
    selectedAppInstanceId: info.selectedAppInstanceId,
    catalogGeneration: info.catalogGeneration,
    apps: info.apps.map(app => ({ ...app })),
  };
}

function installRestoredAuthority(
  restored: ProductionRestoredAuthority,
): Omit<ProductionBootInfo, "adopted"> {
  const previous = mustAuthority();
  if (restored.authority === previous)
    throw new ClayError("E_CATALOG_UNAVAILABLE", "restore-as-new did not create a fresh authority");
  const nextStore = restored.authority.readStore();
  const nextBoot = restored.authority.bootInfo();
  authority = restored.authority;
  authorityBoot = Promise.resolve(restored.authority);
  store = nextStore;
  pending = null;
  automaticBackup = null;
  restoreAsNew = null;
  try { previous.close(); } catch { /* the fresh authority is already authoritative */ }
  return workerBootInfo(nextBoot);
}

function transferredBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0)
    throw new ClayError("E_VALIDATION", `${label} bytes are malformed`);
  return new Uint8Array(value);
}

function transferOwnedBytes(bytes: Uint8Array, label: string): ArrayBuffer {
  if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0
      || bytes.byteLength !== bytes.buffer.byteLength)
    throw new ClayError("E_INTERNAL", `${label} is not a whole owned buffer`);
  return bytes.buffer;
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
  return workerBootInfo(authority.bootInfo());
}

function authorityRequestId(req: Request): string {
  if (req.requestId === undefined) return mustAuthority().createRequestId();
  if (!/^req_[a-z2-7]{26}$/.test(req.requestId))
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "worker request identity is invalid");
  return req.requestId;
}

function publishAuthorityCommit(result: {
  changed: boolean;
  replayed: boolean;
  evidence: unknown;
}): void {
  if (!result.changed || result.replayed) return;
  (self as unknown as Worker).postMessage({
    kind: "authority_commit",
    evidence: structuredClone(result.evidence),
  });
}

async function runAuthorityMutation(
  route: "seed" | "importTable" | "removeSamples" | "fillSamples"
    | "restoreRow" | "undoBatch" | "makeLatest"
    | "setSetting" | "deleteSetting" | "compareAndSetSetting" | "commitLayout",
  payload: unknown,
  req: Request,
): Promise<unknown> {
  const target = mustAuthority();
  const requestId = authorityRequestId(req);
  const execute = async (input: unknown): Promise<unknown> => {
    const committed = await target.executeMutation(input);
    publishAuthorityCommit(committed);
    return committed.result;
  };
  if (route === "seed") return execute({
    requestId,
    route: "starter.seed",
    payload,
  });
  if (route === "importTable") return execute({
    requestId,
    route: "table.import",
    payload,
  });
  if (route === "removeSamples") return execute({
    requestId,
    route: "samples.remove",
    payload,
  });
  if (route === "fillSamples") return execute({
    requestId,
    route: "samples.fill",
    payload,
  });
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "worker mutation payload is invalid");
  const captured = payload as Record<string, unknown>;
  if (route === "restoreRow") return execute({
    requestId, route: "recovery.restoreRow", payload: { table: captured.table, id: captured.id },
  });
  if (route === "undoBatch") return execute({
    requestId, route: "recovery.undoBatch", payload: { id: captured.id },
  });
  if (route === "makeLatest") return execute({
    requestId, route: "recovery.rewind", payload: { version: captured.version },
  });
  if (route === "commitLayout") return execute({
    requestId,
    route: "store.commit",
    payload: { plan: {
      intent: "layout change",
      summary: "Saved layout changes.",
      semanticOrigin: "direct",
      migration: null,
      panels: captured.layout,
      diff: [],
    } },
  });
  if (route === "setSetting") return execute({
    requestId, route: "setting.set", payload: { key: captured.key, value: captured.value },
  });
  if (route === "deleteSetting") return execute({
    requestId, route: "setting.delete", payload: { key: captured.key },
  });
  return execute({
    requestId,
    route: "setting.compareAndSet",
    payload: {
      key: captured.key,
      expectedRevision: captured.expectedRevision,
      value: captured.value,
    },
  });
}

function serveProductionStore(target: "live" | "shadow", port: MessagePort): void {
  const endpoint = target === "shadow"
    ? pending?.shadow ? new InProcessAsyncStore(pending.shadow) : null
    : mustAuthority().asyncStore(publishAuthorityCommit);
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
      return runAuthorityMutation("makeLatest", p, req);
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
    case "recoveryCandidates": {
      const candidates: Array<{
        table: string; id: string; deleted: boolean; historyAt: string; attachmentCount: number;
      }> = [];
      for (const table of mustStore().registrySnapshot().values()) {
        for (const id of mustStore().restorableRows(table.name)) {
          const history = mustStore().rowHistory(table.name, id, 1)[0];
          const row = mustStore().query({
            from: table.name,
            where: [{ field: "id", op: "eq", value: id }],
            includeDeleted: true,
            limit: 1,
          })[0];
          if (!history || !row) continue;
          candidates.push({
            table: table.name,
            id,
            deleted: row.deleted_at !== null && row.deleted_at !== undefined,
            historyAt: history.at,
            attachmentCount: table.columns
              .filter(column => column.type === "attachment" && !column.inactive)
              .reduce((total, column) => {
                const value = history.values[column.name];
                if (typeof value === "string") return total + 1;
                if (Array.isArray(value))
                  return total + value.filter(item => typeof item === "string").length;
                return total;
              }, 0),
          });
        }
      }
      candidates.sort((left, right) => right.historyAt.localeCompare(left.historyAt)
        || left.table.localeCompare(right.table) || left.id.localeCompare(right.id));
      return candidates.slice(0, 50);
    }
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
      return runAuthorityMutation("restoreRow", p, req);
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
      return failClosedMutation(req.op);
    case "backupTrustStatus":
      return mustBackupTrust().status();
    case "beginBackupTrustEnrollment": {
      const enrollment = mustBackupTrust().beginEnrollment();
      const bytes = enrollment.bytes.slice().buffer;
      return { ...enrollment, bytes };
    }
    case "confirmBackupTrustEnrollment":
      return mustBackupTrust().confirmEnrollment(
        String(p.enrollmentId), transferredBytes(p.bytes, "Recovery Kit"),
      );
    case "importRecoveryKit":
      return mustBackupTrust().importRecoveryKit(
        transferredBytes(p.bytes, "Recovery Kit"),
      );
    case "activateImportedBackupSeries":
      return mustBackupTrust().activateImportedSeries(p as never);
    case "backupSelection":
      return mustAuthority().backupSelection();
    case "prepareAutomaticBackup": {
      const prepared = await mustAutomaticBackup().prepare(
        p.target as never, p.reason as never,
      );
      return { ...prepared, bytes: transferOwnedBytes(prepared.bytes, "Backup archive") };
    }
    case "validateBackupStage":
      return mustAutomaticBackup().validateStage(
        transferredBytes(p.bytes, "Backup archive"), p.expected as never,
      );
    case "publishBackup":
      return mustAutomaticBackup().publish(p.request as never);
    case "backupRecords":
      return mustAutomaticBackup().records();
    case "validateRestoreArchive":
      return mustRestoreAsNew().validate(
        transferredBytes(p.bytes, "Restore archive"),
        "transferred",
      );
    case "restoreAsNew":
      return installRestoredAuthority(await mustRestoreAsNew().restore(p.grant));
    case "exportArchive": {
      const exported = await mustAutomaticBackup().prepareManualDownload();
      return { ...exported, bytes: transferOwnedBytes(exported.bytes, "Portable archive") };
    }
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
