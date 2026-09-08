// Typed promise wrapper over the DB worker's command protocol.
import type {
  AttachmentFile, AttachmentMetadata, AttachmentStorageSummary,
  AutomationDefinition, AutomationDefinitionInput, AutomationRun, AutomationSimulation,
  BatchMutation, BatchReceipt, ClayNotification, DebugEvent, FieldProvenance,
  GlobalSearchResult,
  HistoryEntry, IntakeAcceptanceReceipt, IntakeAutoAcceptSimulation, IntakeDeliveryFailure,
  IntakeInboxItem,
  LivePanel, PanelProvenance,
  PrivateMetricEvent, PrivateMetricsSummary, RegTable, RelationConversionPreview,
  RelationConversionRequest, RelationConversionResult, SemanticSchemaTraceV1, Suggestion,
} from "@clay/kernel";
import {
  decodeProjectionArtifactV1,
  type ProjectionArtifactV1,
  type ProjectionRequestV1,
} from "@clay/kernel/projection";
import { ClayError } from "@clay/kernel/errors";
import type {
  IntakeAutoAcceptDraftV1, IntakeAutoAcceptRuleV1,
  IntakeSubmissionPlaintextV1, LocalIntakeFormV1,
} from "@clay/schema/intake";
import type { IntentOutcome } from "../worker/db-worker";

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

export class WorkerClient {
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
      signal?.addEventListener("abort", abort, { once: true });
      this.worker.postMessage({ id, requestId: mintWorkerRequestId(), op, payload }, transfer ?? []);
    });
  }

  /** Terminate the worker, releasing its OPFS access handles. Call before a
   * reload so the next worker can acquire the pool without contention. */
  terminate(): void { try { this.worker.terminate(); } catch { /* already gone */ } }

  async boot(request: BootRequest): Promise<BootInfo> {
    const captured = parseBootRequest(request);
    return parseBootInfo(await this.call<unknown>("boot", captured));
  }
  setModelAccess(access: {
    provider: "clay" | "openai" | "anthropic" | "codex";
    apiKey: string | null; backendUrl: string | null;
    session: string | null; providerToken?: string | null;
  }): Promise<null> {
    return this.call("setModelAccess", {
      provider: access.provider,
      ...(access.apiKey ? { apiKey: access.apiKey } : {}),
      ...(access.backendUrl ? { backendUrl: access.backendUrl } : {}),
      ...(access.provider === "clay" && access.session ? { session: access.session } : {}),
      ...(access.provider === "codex" && access.providerToken
        ? { providerToken: access.providerToken } : {}),
    });
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
  listIntakeForms(): Promise<LocalIntakeFormV1[]> {
    return this.call("listIntakeForms", {});
  }
  saveIntakeForm(form: LocalIntakeFormV1): Promise<LocalIntakeFormV1> {
    return this.call("saveIntakeForm", { form });
  }
  markIntakeFormPublished(formId: string, publishedAt: string): Promise<LocalIntakeFormV1> {
    return this.call("markIntakeFormPublished", { formId, publishedAt });
  }
  revokeIntakeForm(formId: string, revokedAt: string): Promise<LocalIntakeFormV1> {
    return this.call("revokeIntakeForm", { formId, revokedAt });
  }
  markIntakeFormExpired(formId: string, expiredAt: string): Promise<LocalIntakeFormV1> {
    return this.call("markIntakeFormExpired", { formId, expiredAt });
  }
  intakeInbox(): Promise<IntakeInboxItem[]> {
    return this.call("intakeInbox", {});
  }
  intakeReceipts(): Promise<IntakeAcceptanceReceipt[]> {
    return this.call("intakeReceipts", {});
  }
  intakeDeliveryFailures(): Promise<IntakeDeliveryFailure[]> {
    return this.call("intakeDeliveryFailures", {});
  }
  recordIntakeDeliveryFailure(input: {
    formId: string; submissionId: string; envelopeSha256: string; failedAt: string;
  }): Promise<IntakeDeliveryFailure> {
    return this.call("recordIntakeDeliveryFailure", { failure: input });
  }
  authorizeIntakeDeliveryDiscard(
    formId: string, submissionId: string, authorizedAt: string,
  ): Promise<IntakeDeliveryFailure> {
    return this.call("authorizeIntakeDeliveryDiscard", { formId, submissionId, authorizedAt });
  }
  resolveIntakeDeliveryFailure(
    formId: string, submissionId: string, resolution: "staged" | "discarded", resolvedAt: string,
  ): Promise<IntakeDeliveryFailure | null> {
    return this.call("resolveIntakeDeliveryFailure", {
      formId, submissionId, resolution, resolvedAt,
    });
  }
  stageIntakeSubmission(submission: IntakeSubmissionPlaintextV1): Promise<IntakeInboxItem> {
    return this.call("stageIntakeSubmission", { submission });
  }
  rejectIntakeSubmission(submissionId: string): Promise<IntakeInboxItem> {
    return this.call("rejectIntakeSubmission", { submissionId });
  }
  simulateIntakeAutoAccept(draft: IntakeAutoAcceptDraftV1): Promise<IntakeAutoAcceptSimulation> {
    return this.call("simulateIntakeAutoAccept", { draft });
  }
  enableIntakeAutoAccept(
    draft: IntakeAutoAcceptDraftV1,
    simulationFingerprint: string,
  ): Promise<IntakeAutoAcceptRuleV1> {
    return this.call("enableIntakeAutoAccept", { draft, simulationFingerprint });
  }
  disableIntakeAutoAccept(formId: string): Promise<null> {
    return this.call("disableIntakeAutoAccept", { formId });
  }
  processIntakeAutoAccept(formId: string): Promise<IntakeAcceptanceReceipt[]> {
    return this.call("processIntakeAutoAccept", { formId });
  }
  acceptIntakeSubmission(
    submissionId: string,
    approvedFileIds: string[],
  ): Promise<IntakeAcceptanceReceipt> {
    return this.call("acceptIntakeSubmission", {
      submissionId, mode: "manual", approvedFileIds,
    });
  }
  undoIntakeReceipt(receiptId: string): Promise<IntakeAcceptanceReceipt> {
    return this.call("undoIntakeReceipt", { receiptId });
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
  async projectExport(
    request: ProjectionRequestV1, signal?: AbortSignal,
  ): Promise<ProjectionArtifactV1> {
    const transported = await this.call<ProjectionArtifactV1>(
      "projectPlaintextV1", request, undefined, signal,
    );
    const canonicalProjection = decodeProjectionArtifactV1(transported);
    return Object.freeze({
      projection: canonicalProjection,
      plaintext: transported.plaintext.slice(),
      csv: transported.csv.slice(),
    });
  }
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
  deleteSetting(key: string): Promise<null> { return this.call("deleteSetting", { key }); }
  compareAndSetSetting<T>(
    key: string, expectedRevision: number, value: T,
  ): Promise<{ ok: boolean; current: unknown }> {
    return this.call("compareAndSetSetting", { key, expectedRevision, value });
  }

  /** Open a serveStore RPC port on the worker for the Bridge's AsyncStore. */
  openStorePort(target: "live" | "shadow"): MessagePort {
    const channel = new MessageChannel();
    void this.call("storePort", { target }, [channel.port2]);
    channel.port1.start();
    return channel.port1;
  }
}
