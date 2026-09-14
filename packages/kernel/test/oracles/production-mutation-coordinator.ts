// Frozen from f53ac67eb3541b56c5d6bedadc0acbfd78563c64 before transition refactoring.
// Test-only oracle: relative imports relocated; do not update to match production.
import { OperationId, RequestId } from "@clay/schema/standalone/index";
import {
  TargetEvidenceV1,
  RecoverablePresentationRouteV1,
  AutomationCommandPayloadV1,
  IntakeCommandPayloadV1,
  type PresentationMutationOutcomeV1,
  type ProductionRequestReceiptV1 as ProductionRequestReceipt,
  type TargetEvidenceV1 as TargetEvidence,
  type WriteFenceV1 as WriteFence,
} from "@clay/schema/standalone/catalog";
import {
  BackupPublicationRequestV1,
  BackupSelectedTargetV1,
  BackupRemovalAcknowledgementV1,
  BackupRemovalRequestV1,
  type BackupPublicationReceiptV1 as BackupPublicationReceipt,
  type BackupPublicationRequestV1 as BackupPublicationRequest,
  type BackupRecordV1 as BackupRecord,
  type BackupSelectedTargetV1 as BackupSelectedTarget,
} from "@clay/schema/standalone/backup";
import { enumerateCanonicalStateV1 } from "../../src/canonical-state";
import { DAILY_TIME_ZONE_SETTING } from "../../src/daily-calendar";
import {
  DAILY_NAVIGATION_SETTING,
} from "../../src/daily-navigation";
import { DAILY_SOURCE_LIBRARY_SETTING } from "../../src/daily-source-profile";
import { DAILY_CAPTURE_LEDGER } from "../../src/production-daily";
import { MANUAL_BACKUP_LEDGER } from "../../src/production-manual-backup";
import { executeCopiedSampleReattestation } from "../../src/production-samples";
import {
  automationPhysicalTransactionCapability,
  withAutomationPhysicalTransaction,
  isThenable,
  type AutomationPhysicalTransactionCapability,
  type DbDriver,
} from "../../src/db";
import { DeviceCatalog } from "../../src/device-catalog";
import { ClayError } from "../../src/errors";
import {
  FIRST_SUCCESS_SETTING_KEY,
  applyFirstSuccessEvent,
  emptyFirstSuccessState,
  parseFirstSuccessState,
} from "../../src/first-success";
import type { LiveWriteAuthority } from "../../src/live-write-guard";
import { executeAutomationObserverAuthorityRoute, requiresAutomationPhysicalTransaction } from "../../src/production-automation-observer-routes";
import { assertClosedAutomationDraftInput } from "../../src/production-automation-input";
import { LocalIntakeFormV2 } from "@clay/schema/standalone/intake";
import { assertIntakeCommandSource, assertIntakeResponsePublic } from "../../src/production-intake-boundary";
import {
  copyPrivateMetricOperationalState,
  executePrivateMetricAuthorityRoute,
  privateMetricOperationalFingerprint,
} from "../../src/production-private-metric-authority";
import {
  captureCoreMutation,
  executeCapturedCoreMutation,
  isCapturedCoreMutation,
  type CapturedCoreMutation,
} from "./production-core-routes";
import {
  capturePlannerAttemptFinalization,
  capturePlannerAttemptStart,
  capturePreparedMutationCommand,
  type PlannerAttemptFinalization,
  type PreparedMutationCommand,
} from "../../src/planner-command";
import { executePreparedPlannerKeep } from "../../src/planner-authority";
import {
  readProductionRequestReceipt,
  writeProductionRequestReceipt,
  type PersistedProductionRequestReceipt,
} from "../../src/production-request-journal";
import {
  FIXED_OPERATIONAL_MUTATION_PREFIX,
  PRODUCTION_MUTATION_PREFIX,
  PRODUCTION_REQUEST_PREFIX,
  STARTER_SEED_PREFIX,
} from "../../src/production-input-capture";
import {
  encodeAuthorityIdBytes,
  productionOperationIdV1,
  productionOperationIdV2,
} from "../../src/production-operation-id";
import {
  assertCommittedReceiptReservationBinding,
  assertLiveSampleProvenance,
} from "../../src/sample-provenance-proof";
import {
  assertExactSampleProvenance,
  decodeProductionResponse,
  encodeProductionResponse,
  isSampleProducingRoute,
  type ProductionResponseJson as JsonValue,
  type SampleProvenanceCoordinate,
} from "../../src/production-response-envelope";
import {
  captureTableImport,
  executeCapturedTableImport,
  type CapturedTableImport,
} from "../../src/production-import";
import {
  captureStarterSeedBundle,
  executeCapturedStarterSeed,
  starterSeedCatalogMetadata,
  type CapturedStarterSeedBundle,
} from "../../src/production-seed";
import {
  captureSampleFill,
  captureSampleRemoval,
  executeCapturedSampleFill,
  executeCapturedSampleRemoval,
  type CapturedSampleFill,
} from "../../src/production-samples";
import { productionJsonRequestFingerprint, originalPresentationResult } from "../../src/production-presentation-proof";
import {
  captureStrictJson,
  UTF8_ENCODER,
  type StrictJsonCaptureBudget as CaptureBudget,
  type StrictJsonCapturePolicy,
} from "../../src/strict-json-capture";
import { sha256HexSync } from "../../src/state-digest";
import {
  validateAutomationSimulationProof,
  validateAutomationTargetIdentity,
  type AutomationSimulationProofV1,
  type AutomationSimulationRequestV1,
  type AutomationTargetIdentityV1,
} from "../../src/automation-v2";
import { stateLeafHashV1 } from "../../src/state-merkle";
import type { StateMerkleChange } from "../../src/state-merkle-index";
import {
  ClayStore,
  executeCapturedAttachmentAdd,
  refreshStoreAfterPhysicalRollback,
} from "../../src/store";
import { TargetAuthorityStore } from "../../src/target-authority";

const QUICK_CAPTURE_LAST_TABLE_SETTING = "quick_capture_last_table_v1";
const RESERVED_SETTING_OWNERS = new Map<string, string>([
  ["intake_v1", "legacy intake custody quarantine"],
  ["intake_v2", "intake authority"],
  ["shell_id", "starter activation"],
  [DAILY_SOURCE_LIBRARY_SETTING, "Daily Home source authority"],
  [DAILY_NAVIGATION_SETTING, "Daily Home navigation authority"],
  [DAILY_TIME_ZONE_SETTING, "Daily Home calendar authority"],
  [QUICK_CAPTURE_LAST_TABLE_SETTING, "Daily Home capture authority"],
  [DAILY_CAPTURE_LEDGER, "Daily Home capture authority"],
  [MANUAL_BACKUP_LEDGER, "Manual download receipt authority"],
  ["sample_provenance_v1", "starter sample provenance authority"],
  ["sample_rows", "starter sample provenance authority"],
]);

type JsonRecord = { [key: string]: JsonValue };
type CapturedBinary = Readonly<{
  byteLength: number;
  sha256: string;
  /** Private copy. Never pass this view to Store code directly. */
  bytes: Uint8Array;
}>;
type CapturedBatchMutation =
  | Readonly<{ kind: "update"; table: string; id: string; patch: Readonly<JsonRecord> }>
  | Readonly<{ kind: "insert"; table: string; row: Readonly<JsonRecord> }>
  | Readonly<{ kind: "soft_delete"; table: string; id: string }>
  | Readonly<{ kind: "restore"; table: string; id: string }>;

type CapturedProductionMutation = CapturedCoreMutation | Readonly<{
  requestId: string;
} & (
  | { route: "store.insert"; payload: Readonly<{ table: string; row: Readonly<JsonRecord> }> }
  | {
    route: "store.update";
    payload: Readonly<{ table: string; id: string; patch: Readonly<JsonRecord> }>;
  }
  | { route: "store.softDelete"; payload: Readonly<{ table: string; id: string }> }
  | { route: "store.commit"; payload: Readonly<{ plan: Readonly<JsonRecord> }> }
  | { route: "import.commit"; payload: Readonly<JsonRecord> }
  | { route: "import.undo"; payload: Readonly<{ receiptId: string }> }
  | { route: "planner.begin"; payload: Readonly<{ intent: string }> }
  | { route: "planner.finalize"; payload: PlannerAttemptFinalization }
  | { route: "planner.discard"; payload: PreparedMutationCommand }
  | { route: "planner.keep"; payload: PreparedMutationCommand }
  | { route: "table.import"; payload: CapturedTableImport }
  | { route: "samples.fill"; payload: CapturedSampleFill }
  // No public capture/dispatch case. This request can only be created by the
  // authenticated fresh-install helper below, inside its physical transaction.
  | { route: "archive.restore.samples" | "app.fork.samples"; payload: Readonly<{ sourceSha256: string; sourceAuthorityIncarnationId: string; sourceTargetStateSha256: string }> }
  | { route: "samples.remove"; payload: Readonly<Record<string, never>> }
  | { route: "starter.seed"; payload: CapturedStarterSeedBundle }
  | {
    route: "attachment.add";
    payload: Readonly<{
      table: string;
      rowId: string;
      field: string;
      name: string;
      mime: string;
      bytes: CapturedBinary;
    }>;
  }
  | {
    route: "attachment.remove";
    payload: Readonly<{ table: string; rowId: string; field: string; id: string }>;
  }
  | { route: "attachment.purge"; payload: Readonly<Record<never, never>> }
  | {
    route: "batch.apply";
    payload: Readonly<{
      source: "user" | "automation";
      summary: string;
      mutations: readonly CapturedBatchMutation[];
    }>;
  }
  | { route: "batch.undo"; payload: Readonly<{ id: string }> }
  | { route: "row.restore"; payload: Readonly<{ table: string; id: string }> }
  | { route: "schema.removeColumn"; payload: Readonly<{ table: string; column: string }> }
  | { route: "setting.set"; payload: Readonly<{ key: string; value: JsonValue }> }
  | { route: "setting.delete"; payload: Readonly<{ key: string }> }
  | {
    route: "setting.compareAndSet";
    payload: Readonly<{ key: string; expectedRevision: number; value: JsonValue }>;
  }
  | {
    route: "firstSuccess.completeEveryday";
    payload: Readonly<{ action: "open"; table: string; rowId: string }>;
  }
  | { route: "upsertAutomation"; payload: Readonly<{ input: Readonly<JsonRecord> }> }
  | { route: "automation.command"; payload: AutomationCommandPayloadV1 }
  | { route: "intake.command"; payload: IntakeCommandPayloadV1 }
  | {
    route: "saveAutomationDraft";
    payload: Readonly<{ input: Readonly<JsonRecord>; expectedRevision: number | null }>;
  }
  | { route: "saveAutomationRecipeDraft"; payload: Readonly<{ request: Readonly<JsonRecord> }> }
  | {
    route: "enableAutomation" | "runAutomationNow";
    payload: Readonly<{
      id: string;
      expectedRevision: number;
      simulation: Readonly<JsonRecord>;
    }>;
  }
  | { route: "pauseAutomation"; payload: Readonly<{ id: string; expectedRevision: number }> }
  | { route: "deleteAutomation"; payload: Readonly<{ id: string }> }
  | { route: "runDueAutomations"; payload: Readonly<JsonRecord> }
  | { route: "undoAutomationRun"; payload: Readonly<{ id: string }> }
  | { route: "markNotificationRead"; payload: Readonly<{ id: string }> }
  | { route: "recordUsage"; payload: Readonly<{ event: Readonly<JsonRecord> }> }
  | { route: "acceptSuggestion"; payload: Readonly<{ subject: string; kind: string }> }
  | { route: "dismissSuggestion"; payload: Readonly<{ subject: string; kind: string }> }
  | { route: "intake.saveForm"; payload: Readonly<{ form: Readonly<JsonRecord> }> }
  | { route: "intake.closePublication"; payload: Readonly<{ form: Readonly<JsonRecord> }> }
  | { route: "intake.markPublished"; payload: Readonly<{ formId: string; publishedAt: string }> }
  | { route: "intake.revokeForm"; payload: Readonly<{ formId: string; revokedAt: string }> }
  | { route: "intake.markExpired"; payload: Readonly<{ formId: string; expiredAt: string }> }
  | { route: "intake.stageSubmission"; payload: Readonly<{ submission: Readonly<JsonRecord> }> }
  | { route: "intake.recordDeliveryFailure"; payload: Readonly<{ failure: Readonly<JsonRecord> }> }
  | {
    route: "intake.authorizeDeliveryDiscard";
    payload: Readonly<{ formId: string; submissionId: string; authorizedAt: string }>;
  }
  | {
    route: "intake.resolveDeliveryFailure";
    payload: Readonly<{
      formId: string; submissionId: string; resolution: "staged" | "discarded"; resolvedAt: string;
    }>;
  }
  | { route: "intake.rejectSubmission"; payload: Readonly<{ submissionId: string }> }
  | { route: "intake.simulateAutoAccept"; payload: Readonly<{ draft: Readonly<JsonRecord> }> }
  | {
    route: "intake.enableAutoAccept";
    payload: Readonly<{ draft: Readonly<JsonRecord>; simulationFingerprint: string }>;
  }
  | { route: "intake.disableAutoAccept"; payload: Readonly<{ formId: string }> }
  | { route: "intake.processAutoAccept"; payload: Readonly<{ formId: string }> }
  | {
    route: "intake.acceptSubmission";
    payload: Readonly<{
      submissionId: string; mode: "manual" | "auto"; approvedFileIds: readonly string[];
    }>;
  }
  | { route: "intake.undoReceipt"; payload: Readonly<{ receiptId: string }> }
)>;

type CapturedAutomationSimulation = Readonly<{
  id: string;
  expectedRevision: number;
  purpose: "enable" | "run_now" | "proposal_review";
}>;

type CapturedOperationalMetricMutation = Readonly<{
  requestId: string;
} & (
  | { route: "recordPrivateMetric"; payload: Readonly<{ event: Readonly<JsonRecord> }> }
  | { route: "setPrivateMetricsEnabled"; payload: Readonly<{ enabled: boolean }> }
  | { route: "clearPrivateMetrics"; payload: Readonly<JsonRecord> }
)>;

type CapturedMutationExecution = Readonly<{
  result: JsonValue;
  sampleProvenance?: readonly SampleProvenanceCoordinate[];
}>;

export type ProductionMutationResult = {
  requestId: string;
  operationId: string;
  changed: boolean;
  replayed: boolean;
  evidence: TargetEvidence;
  result: unknown;
};

function unavailable(message: string): ClayError {
  return new ClayError("E_CATALOG_UNAVAILABLE", message);
}

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

function sameTarget(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function copyTarget(input: TargetEvidence): TargetEvidence {
  return Object.freeze(TargetEvidenceV1.parse({
    appInstanceId: input.appInstanceId,
    activeGenerationId: input.activeGenerationId,
    lineageEpoch: input.lineageEpoch,
    protectionRevision: input.protectionRevision,
    digestSchema: input.digestSchema,
    stateSha256: input.stateSha256,
  }));
}

function automationTarget(input: TargetEvidence): AutomationTargetIdentityV1 {
  return validateAutomationTargetIdentity({
    v: 1,
    appInstanceId: input.appInstanceId,
    activeGenerationId: input.activeGenerationId,
    lineageEpoch: input.lineageEpoch,
    stateRevision: input.protectionRevision,
    stateDigest: input.stateSha256,
  });
}

function assertSettingKeyAvailable(key: string): void {
  const owner = RESERVED_SETTING_OWNERS.get(key);
  if (owner)
    throw invalid(`reserved setting '${key}' may only be changed by ${owner}`);
}

function selectedCatalogShell(
  catalog: DeviceCatalog,
  target: TargetEvidence,
): string | null {
  const snapshot = catalog.snapshot();
  if (snapshot.selectedAppInstanceId !== target.appInstanceId) return null;
  const entry = snapshot.entries.find(candidate => candidate.appInstanceId === target.appInstanceId);
  if (!entry || entry.activeGenerationId !== target.activeGenerationId
      || entry.currentLineageEpoch !== target.lineageEpoch
      || entry.currentProtectionRevision !== target.protectionRevision
      || entry.digestSchema !== target.digestSchema
      || entry.stateSha256 !== target.stateSha256) return null;
  return entry.shellId;
}

function exactDataFields(
  input: object,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("unexpected prototype");
  const allowedKeys = new Set(allowed);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowed.length
      || keys.some(key => typeof key !== "string" || !allowedKeys.has(key)))
    throw new Error("unexpected key");
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("unexpected property descriptor");
    values[key] = descriptor.value;
  }
  return Object.freeze(values);
}

function exactKeys(input: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("invalid record");
  return exactDataFields(input, allowed);
}

function captureMutationEnvelope(input: unknown): Readonly<{
  requestId: unknown;
  route: unknown;
  payload: unknown;
}> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw invalid(PRODUCTION_MUTATION_PREFIX + "envelope must be a plain data record");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw invalid(PRODUCTION_MUTATION_PREFIX + "envelope must be a plain data record");
  const allowed = ["requestId", "route", "payload"] as const;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowed.length
      || keys.some(key => typeof key !== "string"
        || !allowed.includes(key as typeof allowed[number])))
    throw invalid(PRODUCTION_MUTATION_PREFIX + "envelope fields are invalid");
  const values: Record<typeof allowed[number], unknown> = {
    requestId: undefined,
    route: undefined,
    payload: undefined,
  };
  for (const key of allowed) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw invalid(PRODUCTION_MUTATION_PREFIX + "envelope fields must be plain data properties");
    values[key] = descriptor.value;
  }
  return Object.freeze(values);
}

const MAX_CAPTURE_BYTES = 2_000_000;
const PRODUCTION_CAPTURE_POLICY: StrictJsonCapturePolicy = [
  64, 100_000, 1_000_000, MAX_CAPTURE_BYTES, 10_000, 10_000, 128, true, true,
  reason => {
    if (reason < 5) throw unavailable(reason === 1
      ? PRODUCTION_MUTATION_PREFIX + "payload exceeds aggregate limits"
      : PRODUCTION_MUTATION_PREFIX + "payload exceeds limits");
    const messages = [
      "invalid JSON value",
      "invalid JSON value",
      "cyclic JSON value",
      "invalid array",
      "invalid array keys",
      "invalid array item",
      "invalid record",
      "invalid record property",
    ];
    throw new Error(messages[reason - 5] ?? "invalid JSON value");
  },
];
const MAX_IMPORT_COMMIT_BYTES = 36 * 1024 * 1024;
const IMPORT_COMMIT_CAPTURE_POLICY: StrictJsonCapturePolicy = [
  64, 500_000, 1_000_000, MAX_IMPORT_COMMIT_BYTES, 10_000, 10_000, 128, true, true,
  reason => {
    if (reason < 5) throw unavailable(PRODUCTION_MUTATION_PREFIX + "import payload exceeds limits");
    const messages = [
      "invalid JSON value",
      "invalid JSON value",
      "cyclic JSON value",
      "invalid array",
      "invalid array keys",
      "invalid array item",
      "invalid record",
      "invalid record property",
    ];
    throw new Error(messages[reason - 5] ?? "invalid JSON value");
  },
];
const MAX_INTAKE_CAPTURE_BYTES = 12 * 1024 * 1024;
const INTAKE_CAPTURE_POLICY: StrictJsonCapturePolicy = [
  64, 500_000, 7_000_000, MAX_INTAKE_CAPTURE_BYTES, 10_000, 10_000, 128, true, true,
  reason => {
    if (reason < 5) throw unavailable(PRODUCTION_MUTATION_PREFIX + "intake payload exceeds limits");
    const messages = [
      "invalid JSON value",
      "invalid JSON value",
      "cyclic JSON value",
      "invalid array",
      "invalid array keys",
      "invalid array item",
      "invalid record",
      "invalid record property",
    ];
    throw new Error(messages[reason - 5] ?? "invalid JSON value");
  },
];

function consumeCaptureBytes(
  budget: CaptureBudget,
  bytes: number,
  subject: "payload" | "binary payload" = "payload",
): void {
  budget.bytes += bytes;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_CAPTURE_BYTES)
    throw unavailable(`production mutation ${subject} exceeds aggregate limits`);
}

function chargeCaptureText(value: string, budget: CaptureBudget, framingBytes = 0): void {
  consumeCaptureBytes(budget, UTF8_ENCODER.encode(value).byteLength + framingBytes);
}

function chargeRecordFrame(keys: readonly string[], budget: CaptureBudget): void {
  consumeCaptureBytes(budget, 2 + Math.max(0, keys.length - 1));
  for (const key of keys) chargeCaptureText(key, budget, 3);
}

function captureJsonValue(
  input: unknown,
  seen: WeakSet<object>,
  depth = 0,
  budget: CaptureBudget = { nodes: 0, bytes: 0 },
): JsonValue {
  return captureStrictJson(input, PRODUCTION_CAPTURE_POLICY, seen, budget, depth) as JsonValue;
}

function captureBinary(input: unknown, budget: CaptureBudget): CapturedBinary {
  let source: Uint8Array;
  if (input instanceof ArrayBuffer && Reflect.getPrototypeOf(input) === ArrayBuffer.prototype) {
    source = new Uint8Array(input);
  } else if (input instanceof Uint8Array
      && Reflect.getPrototypeOf(input) === Uint8Array.prototype) {
    source = input;
  } else {
    throw new Error();
  }
  const byteLength = source.byteLength;
  consumeCaptureBytes(budget, byteLength, "binary payload");
  const bytes = new Uint8Array(byteLength);
  bytes.set(source);
  return Object.freeze({
    byteLength,
    sha256: sha256HexSync(bytes),
    bytes,
  });
}

function captureJsonRecord(
  input: unknown,
  budget: CaptureBudget = { nodes: 0, bytes: 0 },
): Readonly<JsonRecord> {
  const captured = captureJsonValue(input, new WeakSet(), 0, budget);
  if (typeof captured !== "object" || captured === null || Array.isArray(captured))
    throw new Error("expected record");
  return captured;
}

function captureIntakeJsonRecord(input: unknown): Readonly<JsonRecord> {
  const captured = captureStrictJson(
    input, INTAKE_CAPTURE_POLICY, new WeakSet(), { nodes: 0, bytes: 0 }, 0,
  ) as JsonValue;
  return capturedJsonRecord(captured);
}

function captureImportCommitPayload(input: unknown): Readonly<JsonRecord> {
  const fields = [
    "appInstanceId", "sessionId", "previewId", "previewDigest", "sourceKind",
    "sourceDigest", "baseVersion", "target", "dispositions", "mutations",
    "sourceTotals", "mutationTotals", "warningTotals", "receiptId", "summary",
  ] as const;
  const payload = exactKeys(input, fields);
  const captured = captureStrictJson(
    payload,
    IMPORT_COMMIT_CAPTURE_POLICY,
    new WeakSet(),
    { nodes: 0, bytes: 0 },
    0,
  ) as JsonValue;
  return capturedJsonRecord(captured);
}

function capturedJsonRecord(input: JsonValue | undefined): Readonly<JsonRecord> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("expected record");
  return input;
}

function capturePayload(input: unknown, fields: readonly string[]): Readonly<JsonRecord> {
  const source = exactKeys(input, fields);
  const staged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) staged[field] = source[field];
  // The payload record itself was already counted by the old route-specific
  // capture, so offset its depth while retaining identical node/byte limits.
  return capturedJsonRecord(captureJsonValue(staged, new WeakSet(), -1));
}

function capturedProductionMutation(
  requestId: string,
  route: string,
  payload: unknown,
): CapturedProductionMutation {
  return Object.freeze({ requestId, route, payload }) as CapturedProductionMutation;
}

function captureBatchMutations(
  captured: JsonValue | undefined,
): readonly CapturedBatchMutation[] {
  if (!Array.isArray(captured) || captured.length < 1 || captured.length > 500)
    throw unavailable("production batch must contain 1 to 500 mutations");
  const output: CapturedBatchMutation[] = [];
  for (let index = 0; index < captured.length; index++) {
    const mutation = capturedJsonRecord(captured[index]);
    const kind = mutation.kind;
    if (kind === "insert") {
      const fields = exactDataFields(mutation, ["kind", "table", "row"]);
      if (typeof fields.table !== "string") throw new Error();
      output.push(Object.freeze({
        kind, table: fields.table, row: capturedJsonRecord(fields.row as JsonValue),
      }));
    } else if (kind === "update") {
      const fields = exactDataFields(mutation, ["kind", "table", "id", "patch"]);
      if (typeof fields.table !== "string" || typeof fields.id !== "string") throw new Error();
      output.push(Object.freeze({
        kind, table: fields.table, id: fields.id,
        patch: capturedJsonRecord(fields.patch as JsonValue),
      }));
    } else if (kind === "soft_delete" || kind === "restore") {
      const fields = exactDataFields(mutation, ["kind", "table", "id"]);
      if (typeof fields.table !== "string" || typeof fields.id !== "string") throw new Error();
      output.push(Object.freeze({ kind, table: fields.table, id: fields.id }));
    } else {
      throw new Error();
    }
  }
  return Object.freeze(output);
}

function validateCapturedUsageEvent(captured: Readonly<JsonRecord>): Readonly<JsonRecord> {
  const keys = Object.keys(captured);
  if (keys.length < 2 || keys.length > 3
      || keys.some(key => key !== "kind" && key !== "subject" && key !== "detail")
      || !Object.hasOwn(captured, "kind") || !Object.hasOwn(captured, "subject"))
    throw new Error("invalid usage event fields");
  if (captured.kind !== "insert" && captured.kind !== "update"
      && captured.kind !== "filter" && captured.kind !== "view")
    throw new Error("invalid usage event kind");
  if (typeof captured.subject !== "string" || captured.subject.length < 1
      || captured.subject.length > 256)
    throw new Error("invalid usage event subject");
  if (Object.hasOwn(captured, "detail")
      && (captured.detail === null || typeof captured.detail !== "object"
        || Array.isArray(captured.detail)))
    throw new Error("invalid usage event detail");
  return captured;
}

function captureAutomationSimulation(input: unknown): CapturedAutomationSimulation {
  try {
    const captured = captureJsonRecord(input);
    const fields = exactDataFields(captured, ["id", "expectedRevision", "purpose"]);
    if (typeof fields.id !== "string" || !Number.isSafeInteger(fields.expectedRevision)
        || Number(fields.expectedRevision) < 1
        || (fields.purpose !== "enable" && fields.purpose !== "run_now"
          && fields.purpose !== "proposal_review")) throw new Error();
    return Object.freeze({
      id: fields.id,
      expectedRevision: Number(fields.expectedRevision),
      purpose: fields.purpose,
    });
  } catch (error) {
    if (error instanceof ClayError) throw error;
    throw invalid("production automation simulation request is invalid");
  }
}

function captureMutation(input: unknown): CapturedProductionMutation {
  try {
    const envelope = captureMutationEnvelope(input);
    const requestId = envelope.requestId;
    const route = envelope.route;
    const payload = envelope.payload;
    if (typeof requestId !== "string" || !/^req_[a-z2-7]{26}$/.test(requestId)
        || typeof route !== "string"
        || typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    const done = (captured: unknown): CapturedProductionMutation =>
      capturedProductionMutation(requestId, route, captured);
    switch (route) {
      case "intake.command": {
        const captured = IntakeCommandPayloadV1.parse(captureJsonRecord(payload));
        const inner = captureMutation({ requestId, route: captured.command.route, payload: captured.command.payload });
        return done(captureJsonRecord({ ...captured, command: { route: inner.route, payload: inner.payload } }));
      }
      case "automation.command": {
        const captured = AutomationCommandPayloadV1.parse(captureJsonRecord(payload));
        // The closed inner route enumeration excludes this envelope.
        const inner = captureMutation({ requestId, route: captured.command.route, payload: captured.command.payload });
        if (inner.route === "saveAutomationDraft") assertClosedAutomationDraftInput(inner.payload.input);
        return done(captureJsonRecord({ ...captured, command: { route: inner.route, payload: inner.payload } }));
      }
      case "planner.begin": return done(capturePlannerAttemptStart(payload));
      case "planner.finalize": return done(capturePlannerAttemptFinalization(payload));
      case "planner.discard":
      case "planner.keep": return done(capturePreparedMutationCommand(payload));
      case "table.import": return done(captureTableImport(payload));
      case "import.commit": return done(captureImportCommitPayload(payload));
      case "samples.remove": return done(captureSampleRemoval(payload));
      case "samples.fill": return done(captureSampleFill(payload));
      case "starter.seed": return done(captureStarterSeedBundle(payload));
      case "timeline.setCheckpoint":
      case "daily.source":
      case "daily.navigation":
      case "daily.timeZone":
      case "daily.capture":
      case "daily.undoCapture":
      case "daily.inbox":
      case "daily.undoInbox":
      case "timeline.makeLatest":
      case "panel.revert":
      case "panel.rename":
      case "panel.remove":
      case "schema.addColumn":
      case "schema.renameColumn":
      case "schema.convertTextToRelation":
      case "schema.undoRelationConversion":
      case "backup.manualDownload":
      case "schema.addRelationColumn": {
        const captured = captureCoreMutation(requestId, route, captureJsonRecord(payload));
        if (captured) return captured;
        throw new Error();
      }
      case "attachment.add": {
        const keys = ["table", "rowId", "field", "name", "mime", "bytes"] as const;
        const fields = exactKeys(payload, keys);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(keys, budget);
        const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const key of keys.slice(0, -1)) {
          const value = captureJsonValue(fields[key], new WeakSet(), 0, budget);
          if (typeof value !== "string") throw new Error();
          captured[key] = value;
        }
        captured.bytes = captureBinary(fields.bytes, budget);
        return done(Object.freeze(captured));
      }
      case "intake.stageSubmission": {
        const fields = exactKeys(payload, ["submission"]);
        return done(Object.freeze({
          submission: captureIntakeJsonRecord(fields.submission),
        }));
      }
    }

    let fields: readonly string[];
    switch (route) {
      case "store.insert": fields = ["table", "row"]; break;
      case "store.update": fields = ["table", "id", "patch"]; break;
      case "store.softDelete":
      case "row.restore": fields = ["table", "id"]; break;
      case "store.commit": fields = ["plan"]; break;
      case "import.undo": fields = ["receiptId"]; break;
      case "attachment.remove": fields = ["table", "rowId", "field", "id"]; break;
      case "attachment.purge":
      case "runDueAutomations": fields = []; break;
      case "batch.apply": fields = ["source", "summary", "mutations"]; break;
      case "batch.undo":
      case "deleteAutomation":
      case "undoAutomationRun":
      case "markNotificationRead": fields = ["id"]; break;
      case "saveAutomationDraft": fields = ["input", "expectedRevision"]; break;
      case "saveAutomationRecipeDraft": fields = ["request"]; break;
      case "enableAutomation":
      case "runAutomationNow": fields = ["id", "expectedRevision", "simulation"]; break;
      case "pauseAutomation": fields = ["id", "expectedRevision"]; break;
      case "schema.removeColumn": fields = ["table", "column"]; break;
      case "setting.set": fields = ["key", "value"]; break;
      case "setting.delete": fields = ["key"]; break;
      case "setting.compareAndSet": fields = ["key", "expectedRevision", "value"]; break;
      case "firstSuccess.completeEveryday": fields = ["action", "table", "rowId"]; break;
      case "upsertAutomation": fields = ["input"]; break;
      case "recordUsage": fields = ["event"]; break;
      case "acceptSuggestion":
      case "dismissSuggestion": fields = ["subject", "kind"]; break;
      case "intake.saveForm":
      case "intake.closePublication": fields = ["form"]; break;
      case "intake.markPublished": fields = ["formId", "publishedAt"]; break;
      case "intake.revokeForm": fields = ["formId", "revokedAt"]; break;
      case "intake.markExpired": fields = ["formId", "expiredAt"]; break;
      case "intake.recordDeliveryFailure": fields = ["failure"]; break;
      case "intake.authorizeDeliveryDiscard":
        fields = ["formId", "submissionId", "authorizedAt"]; break;
      case "intake.resolveDeliveryFailure":
        fields = ["formId", "submissionId", "resolution", "resolvedAt"]; break;
      case "intake.rejectSubmission": fields = ["submissionId"]; break;
      case "intake.simulateAutoAccept": fields = ["draft"]; break;
      case "intake.enableAutoAccept": fields = ["draft", "simulationFingerprint"]; break;
      case "intake.disableAutoAccept":
      case "intake.processAutoAccept": fields = ["formId"]; break;
      case "intake.acceptSubmission": fields = ["submissionId", "mode", "approvedFileIds"]; break;
      case "intake.undoReceipt": fields = ["receiptId"]; break;
      default: throw new Error();
    }
    const captured = capturePayload(payload, fields);
    const strings = (...keys: string[]): void => {
      if (keys.some(key => typeof captured[key] !== "string")) throw new Error();
    };
    switch (route) {
      case "store.insert":
        strings("table"); capturedJsonRecord(captured.row); break;
      case "store.update":
        strings("table", "id"); capturedJsonRecord(captured.patch); break;
      case "store.softDelete":
      case "row.restore": strings("table", "id"); break;
      case "store.commit": capturedJsonRecord(captured.plan); break;
      case "import.undo": strings("receiptId"); break;
      case "attachment.remove": strings("table", "rowId", "field", "id"); break;
      case "batch.apply": {
        if (captured.source !== "user" && captured.source !== "automation") throw new Error();
        strings("summary");
        return done(Object.freeze({
          source: captured.source,
          summary: captured.summary,
          mutations: captureBatchMutations(captured.mutations),
        }));
      }
      case "batch.undo":
      case "deleteAutomation":
      case "undoAutomationRun":
      case "markNotificationRead": strings("id"); break;
      case "saveAutomationDraft":
        capturedJsonRecord(captured.input);
        if (captured.expectedRevision !== null
            && (!Number.isSafeInteger(captured.expectedRevision)
              || Number(captured.expectedRevision) < 0)) throw new Error();
        break;
      case "saveAutomationRecipeDraft":
        capturedJsonRecord(captured.request);
        break;
      case "enableAutomation":
      case "runAutomationNow":
        strings("id");
        if (!Number.isSafeInteger(captured.expectedRevision)
            || Number(captured.expectedRevision) < 1) throw new Error();
        try { validateAutomationSimulationProof(capturedJsonRecord(captured.simulation)); }
        catch { throw new Error(); }
        break;
      case "pauseAutomation":
        strings("id");
        if (!Number.isSafeInteger(captured.expectedRevision)
            || Number(captured.expectedRevision) < 1) throw new Error();
        break;
      case "schema.removeColumn": strings("table", "column"); break;
      case "setting.set":
      case "setting.delete":
        strings("key"); assertSettingKeyAvailable(captured.key as string); break;
      case "setting.compareAndSet":
        strings("key");
        if (!Number.isSafeInteger(captured.expectedRevision)
            || Number(captured.expectedRevision) < 0) throw new Error();
        assertSettingKeyAvailable(captured.key as string);
        break;
      case "firstSuccess.completeEveryday":
        strings("action", "table", "rowId");
        if (captured.action !== "open"
            || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(captured.table as string)
            || (captured.rowId as string).length < 1
            || (captured.rowId as string).length > 128) throw new Error();
        break;
      case "upsertAutomation": capturedJsonRecord(captured.input); break;
      case "recordUsage": validateCapturedUsageEvent(capturedJsonRecord(captured.event)); break;
      case "acceptSuggestion":
      case "dismissSuggestion":
        strings("subject", "kind");
        if ((captured.subject as string).length < 1 || ![
          "promote_to_status", "pin_filtered_panel", "add_view", "flag_overdue",
          "regroup_board", "make_workflow", "chart_metric",
        ].includes(captured.kind as string)) throw new Error();
        break;
      case "intake.saveForm":
      case "intake.closePublication": LocalIntakeFormV2.parse(capturedJsonRecord(captured.form)); break;
      case "intake.markPublished": strings("formId", "publishedAt"); break;
      case "intake.revokeForm": strings("formId", "revokedAt"); break;
      case "intake.markExpired": strings("formId", "expiredAt"); break;
      case "intake.recordDeliveryFailure": capturedJsonRecord(captured.failure); break;
      case "intake.authorizeDeliveryDiscard": strings("formId", "submissionId", "authorizedAt"); break;
      case "intake.resolveDeliveryFailure":
        strings("formId", "submissionId", "resolvedAt");
        if (captured.resolution !== "staged" && captured.resolution !== "discarded")
          throw new Error();
        break;
      case "intake.rejectSubmission": strings("submissionId"); break;
      case "intake.simulateAutoAccept": capturedJsonRecord(captured.draft); break;
      case "intake.enableAutoAccept":
        strings("simulationFingerprint");
        capturedJsonRecord(captured.draft);
        break;
      case "intake.disableAutoAccept":
      case "intake.processAutoAccept": strings("formId"); break;
      case "intake.acceptSubmission":
        strings("submissionId");
        if (captured.mode !== "manual" && captured.mode !== "auto") throw new Error();
        if (!Array.isArray(captured.approvedFileIds)
            || captured.approvedFileIds.some(value => typeof value !== "string"))
          throw new Error();
        break;
      case "intake.undoReceipt": strings("receiptId"); break;
    }
    return done(captured);
  } catch (error) {
    if (error instanceof ClayError) throw error;
    throw invalid(PRODUCTION_MUTATION_PREFIX + "request is invalid");
  }
}

function captureOperationalMetricMutation(input: unknown): CapturedOperationalMetricMutation {
  try {
    const envelope = captureMutationEnvelope(input);
    const requestId = envelope.requestId;
    const route = envelope.route;
    const payload = envelope.payload;
    if (typeof requestId !== "string" || !/^req_[a-z2-7]{26}$/.test(requestId)
        || typeof payload !== "object" || payload === null || Array.isArray(payload))
      throw new Error();
    const capturedPayload = captureJsonRecord(payload);
    switch (route) {
      case "recordPrivateMetric": {
        const fields = exactDataFields(capturedPayload, ["event"]);
        return Object.freeze({ requestId, route, payload: Object.freeze({
          event: capturedJsonRecord(fields.event as JsonValue),
        }) });
      }
      case "setPrivateMetricsEnabled": {
        const fields = exactDataFields(capturedPayload, ["enabled"]);
        if (typeof fields.enabled !== "boolean") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({
          enabled: fields.enabled,
        }) });
      }
      case "clearPrivateMetrics":
        exactDataFields(capturedPayload, []);
        return Object.freeze({ requestId, route, payload: Object.freeze({}) });
      default:
        throw new Error();
    }
  } catch (error) {
    if (error instanceof ClayError) throw error;
    throw invalid("operational metric mutation request is invalid");
  }
}

function assertCapturedMutationBytes(request: CapturedProductionMutation): void {
  const serialized = JSON.stringify(request.payload);
  const limit = request.route === "import.commit"
    ? MAX_IMPORT_COMMIT_BYTES
    : request.route.startsWith("intake.")
      ? MAX_INTAKE_CAPTURE_BYTES
      : MAX_CAPTURE_BYTES;
  if (UTF8_ENCODER.encode(serialized).byteLength > limit)
    throw invalid(PRODUCTION_MUTATION_PREFIX
      + `request exceeds ${limit.toLocaleString("en-US")} UTF-8 bytes`);
}

type FixedOperationalMutation = CapturedOperationalMetricMutation;

function requestFingerprint(expected: TargetEvidence, request: CapturedProductionMutation): string {
  const fingerprintRequest: JsonValue = request.route === "attachment.add"
    ? {
      requestId: request.requestId,
      route: request.route,
      payload: {
        table: request.payload.table,
        rowId: request.payload.rowId,
        field: request.payload.field,
        name: request.payload.name,
        mime: request.payload.mime,
        bytes: {
          byteLength: request.payload.bytes.byteLength,
          sha256: request.payload.bytes.sha256,
        },
      },
    }
    : request as unknown as JsonValue;
  return productionJsonRequestFingerprint(expected, fingerprintRequest);
}

type AuthorityIdPrefix = "app" | "gen" | "ns" | "op" | "rel" | "req";

function encodeAuthorityId(prefix: AuthorityIdPrefix, bytes: Uint8Array): string {
  const id = encodeAuthorityIdBytes(prefix, bytes);
  if (id.length !== prefix.length + 27) throw unavailable("trusted identity source failed");
  return id;
}

export function mintProductionAuthorityId(prefix: AuthorityIdPrefix): string {
  const cryptoSource = (globalThis as unknown as {
    crypto?: { getRandomValues<T extends Uint8Array>(value: T): T };
  }).crypto;
  if (!cryptoSource?.getRandomValues)
    throw unavailable("trusted operation identity source is unavailable");
  const id = encodeAuthorityId(prefix, cryptoSource.getRandomValues(new Uint8Array(17)));
  if (prefix === "op" && !OperationId.safeParse(id).success)
    throw unavailable("trusted operation identity source failed");
  if (prefix === "req" && !/^req_[a-z2-7]{26}$/.test(id))
    throw unavailable("trusted request identity source failed");
  return id;
}

function operationIdForOperationalMetric(
  authorityIncarnationId: string,
  requestId: string,
): string {
  const digest = sha256HexSync(new TextEncoder().encode(
    `clay-operational-metric-operation-v1\u0000${authorityIncarnationId}\u0000${requestId}`,
  ));
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  return OperationId.parse(encodeAuthorityId("op", bytes));
}

function trustedInstant(clock: () => number): { milliseconds: number; instant: string } {
  const milliseconds = clock();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw invalid("trusted worker clock is invalid");
  try { return { milliseconds, instant: new Date(milliseconds).toISOString() }; }
  catch { throw invalid("trusted worker clock is invalid"); }
}

const STORE_INSERT: ClayStore["insert"] = ClayStore.prototype.insert;
const STORE_UPDATE: ClayStore["update"] = ClayStore.prototype.update;
const STORE_SOFT_DELETE: ClayStore["softDelete"] = ClayStore.prototype.softDelete;
const STORE_COMMIT: ClayStore["commit"] = ClayStore.prototype.commit;
const STORE_COMMIT_IMPORT: ClayStore["commitImport"] = ClayStore.prototype.commitImport;
const STORE_UNDO_IMPORT: ClayStore["undoImport"] = ClayStore.prototype.undoImport;
const STORE_REMOVE_ATTACHMENT: ClayStore["removeAttachment"] = ClayStore.prototype.removeAttachment;
const STORE_PURGE_ATTACHMENTS: ClayStore["purgeDeletedAttachments"] =
  ClayStore.prototype.purgeDeletedAttachments;
const STORE_APPLY_BATCH: ClayStore["applyBatch"] = ClayStore.prototype.applyBatch;
const STORE_UNDO_BATCH: ClayStore["undoBatch"] = ClayStore.prototype.undoBatch;
const STORE_RESTORE_ROW: ClayStore["restoreRow"] = ClayStore.prototype.restoreRow;
const STORE_QUERY: ClayStore["query"] = ClayStore.prototype.query;
const STORE_REGISTRY_SNAPSHOT: ClayStore["registrySnapshot"] = ClayStore.prototype.registrySnapshot;
const STORE_VALIDATION_REGISTRY_SNAPSHOT: ClayStore["validationRegistrySnapshot"] =
  ClayStore.prototype.validationRegistrySnapshot;
const STORE_BEGIN_ATTEMPT: ClayStore["beginAttempt"] = ClayStore.prototype.beginAttempt;
const STORE_FINISH_ATTEMPT: ClayStore["finishAttempt"] = ClayStore.prototype.finishAttempt;
const STORE_RELOAD_AFTER_ROLLBACK: ClayStore["reloadRegistryAfterRollback"] =
  ClayStore.prototype.reloadRegistryAfterRollback;
const STORE_GET_SETTING: ClayStore["getSetting"] = ClayStore.prototype.getSetting;
const STORE_SET_SETTING: ClayStore["setSetting"] = ClayStore.prototype.setSetting;
const STORE_DELETE_SETTING: ClayStore["deleteSetting"] = ClayStore.prototype.deleteSetting;
const STORE_SAMPLE_PROVENANCE: ClayStore["sampleRowProvenance"] =
  ClayStore.prototype.sampleRowProvenance;
const STORE_SAVE_INTAKE_FORM: ClayStore["saveIntakeForm"] = ClayStore.prototype.saveIntakeForm;
const STORE_CLOSE_INTAKE_PUBLICATION = ClayStore.prototype.closeIntakePublication;
const STORE_MARK_INTAKE_FORM_PUBLISHED: ClayStore["markIntakeFormPublished"] =
  ClayStore.prototype.markIntakeFormPublished;
const STORE_REVOKE_INTAKE_FORM: ClayStore["revokeIntakeForm"] = ClayStore.prototype.revokeIntakeForm;
const STORE_MARK_INTAKE_FORM_EXPIRED: ClayStore["markIntakeFormExpired"] =
  ClayStore.prototype.markIntakeFormExpired;
const STORE_STAGE_INTAKE: ClayStore["stageIntakeSubmission"] = ClayStore.prototype.stageIntakeSubmission;
const STORE_RECORD_INTAKE_DELIVERY_FAILURE: ClayStore["recordIntakeDeliveryFailure"] =
  ClayStore.prototype.recordIntakeDeliveryFailure;
const STORE_AUTHORIZE_INTAKE_DELIVERY_DISCARD: ClayStore["authorizeIntakeDeliveryDiscard"] =
  ClayStore.prototype.authorizeIntakeDeliveryDiscard;
const STORE_RESOLVE_INTAKE_DELIVERY_FAILURE: ClayStore["resolveIntakeDeliveryFailure"] =
  ClayStore.prototype.resolveIntakeDeliveryFailure;
const STORE_REJECT_INTAKE: ClayStore["rejectIntakeSubmission"] = ClayStore.prototype.rejectIntakeSubmission;
const STORE_SIMULATE_INTAKE_AUTO: ClayStore["simulateIntakeAutoAccept"] =
  ClayStore.prototype.simulateIntakeAutoAccept;
const STORE_ENABLE_INTAKE_AUTO: ClayStore["enableIntakeAutoAccept"] =
  ClayStore.prototype.enableIntakeAutoAccept;
const STORE_DISABLE_INTAKE_AUTO: ClayStore["disableIntakeAutoAccept"] =
  ClayStore.prototype.disableIntakeAutoAccept;
const STORE_PROCESS_INTAKE_AUTO: ClayStore["processIntakeAutoAccept"] =
  ClayStore.prototype.processIntakeAutoAccept;
const STORE_ACCEPT_INTAKE: ClayStore["acceptIntakeSubmission"] = ClayStore.prototype.acceptIntakeSubmission;
const STORE_UNDO_INTAKE: ClayStore["undoIntakeReceipt"] = ClayStore.prototype.undoIntakeReceipt;

function sampleProvenanceCoordinates(
  store: ClayStore,
  operationId: string,
): SampleProvenanceCoordinate[] {
  return STORE_SAMPLE_PROVENANCE.call(store)
    .filter(entry => entry.operationId === operationId)
    .map(entry => Object.freeze({ tableId: entry.tableId, rowId: entry.rowId }));
}

function executeFirstSuccessEveryday(
  store: ClayStore,
  payload: Readonly<{ action: "open"; table: string; rowId: string }>,
): JsonValue {
  const table = STORE_VALIDATION_REGISTRY_SNAPSHOT.call(store).get(payload.table);
  const tableId = table?.semantic?.tableId;
  if (!table || table.inactive || !tableId)
    throw invalid("Everyday action did not read back a canonical real record");
  if (STORE_SAMPLE_PROVENANCE.call(store).some(entry =>
    entry.tableId === tableId && entry.rowId === payload.rowId))
    throw invalid("Everyday action cannot use a starter sample record");
  const row = STORE_QUERY.call(store, {
    from: payload.table,
    where: [{ field: "id", op: "eq", value: payload.rowId }],
    limit: 1,
  })[0];
  if (!row || String(row.id) !== payload.rowId || row.deleted_at != null)
    throw invalid("Everyday action did not read back a canonical real record");

  const stored: unknown = STORE_GET_SETTING.call(store, FIRST_SUCCESS_SETTING_KEY);
  const current = stored === undefined || stored === null
    ? emptyFirstSuccessState() : parseFirstSuccessState(stored);
  const applied = applyFirstSuccessEvent(current, {
    type: "everyday_action", action: payload.action, changed: true, sample: false,
  });
  if (applied === current) {
    if (current.steps.everyday.state === "complete")
      return captureJsonValue(current, new WeakSet());
    throw invalid("The first real record must be verified before an everyday action");
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER)
    throw invalid("First-success progress revision cannot advance");
  const next = { ...applied, revision: current.revision + 1 };
  STORE_SET_SETTING.call(store, FIRST_SUCCESS_SETTING_KEY, next);
  return captureJsonValue(next, new WeakSet());
}

function capturedExecution(
  result: JsonValue,
  sampleProvenance?: readonly SampleProvenanceCoordinate[],
): CapturedMutationExecution {
  return Object.freeze({
    result,
    ...(sampleProvenance === undefined ? {} : { sampleProvenance }),
  });
}

function usesSampleProvenance(route: string): boolean {
  return isSampleProducingRoute(route) || route === "samples.remove";
}

function executeCapturedMutation(
  store: ClayStore,
  request: CapturedProductionMutation,
  executionInstant: string | null,
  operationId: string,
  expectedTarget: TargetEvidence,
  transactionCapability: AutomationPhysicalTransactionCapability,
  driver: DbDriver,
): CapturedMutationExecution {
  if (request.route === "archive.restore.samples" || request.route === "app.fork.samples")
    throw invalid("sample re-attestation requires the fresh-install capability");
  if (request.route === "automation.command" || request.route === "intake.command") {
    if (!sameTarget(request.payload.authorityTarget, expectedTarget))
      throw invalid("Reviewed command source changed; reconcile the original request before reviewing again");
    return executeCapturedMutation(store, captureMutation({ requestId: request.requestId,
      route: request.payload.command.route, payload: request.payload.command.payload }),
      executionInstant, operationId, expectedTarget, transactionCapability, driver);
  }
  if (request.route.startsWith("intake.")) assertIntakeCommandSource(store, request.route, request.payload, expectedTarget);
  if (isCapturedCoreMutation(request))
    return capturedExecution(captureJsonValue(
      executeCapturedCoreMutation(store, request, expectedTarget, driver, executionInstant ?? undefined), new WeakSet(),
    ));
  switch (request.route) {
    case "store.insert":
      return capturedExecution(captureJsonValue(STORE_INSERT.call(
        store,
        request.payload.table,
        request.payload.row as Record<string, unknown>,
      ), new WeakSet()));
    case "store.update":
      return capturedExecution(captureJsonValue(STORE_UPDATE.call(
        store,
        request.payload.table,
        request.payload.id,
        request.payload.patch as Record<string, unknown>,
      ), new WeakSet()));
    case "store.softDelete":
      STORE_SOFT_DELETE.call(store, request.payload.table, request.payload.id);
      return capturedExecution(null);
    case "store.commit":
      return capturedExecution(STORE_COMMIT.call(
        store,
        request.payload.plan as unknown as Parameters<ClayStore["commit"]>[0],
      ));
    case "import.commit":
      return capturedExecution(captureJsonValue(STORE_COMMIT_IMPORT.call(
        store,
        request.payload as unknown as Parameters<ClayStore["commitImport"]>[0],
      ), new WeakSet()));
    case "import.undo":
      return capturedExecution(captureJsonValue(STORE_UNDO_IMPORT.call(
        store,
        request.payload.receiptId,
      ), new WeakSet()));
    case "planner.begin":
      return capturedExecution(STORE_BEGIN_ATTEMPT.call(store, request.payload.intent));
    case "planner.finalize":
      STORE_FINISH_ATTEMPT.call(
        store,
        request.payload.attemptId,
        request.payload.outcome,
        request.payload.errorCode,
      );
      return capturedExecution(null);
    case "planner.discard":
      STORE_FINISH_ATTEMPT.call(
        store,
        request.payload.attemptId,
        "discarded",
        null,
        request.payload.intent,
      );
      return capturedExecution(null);
    case "planner.keep":
      return capturedExecution(executePreparedPlannerKeep(store, request.payload));
    case "table.import":
      return capturedExecution(captureJsonValue(
        executeCapturedTableImport(store, request.payload), new WeakSet(),
      ));
    case "samples.remove":
      return capturedExecution(captureJsonValue(
        executeCapturedSampleRemoval(store), new WeakSet(),
      ));
    case "samples.fill":
      if (sampleProvenanceCoordinates(store, operationId).length !== 0)
        throw invalid("sample fill operation provenance already exists");
      {
        const outcome = executeCapturedSampleFill(store, request.payload, operationId);
        const expected = request.payload.tables.reduce(
          (total, table) => total + table.rows.length, 0,
        );
        const persisted = sampleProvenanceCoordinates(store, operationId);
        assertExactSampleProvenance(
          outcome.sampleProvenance, persisted, expected, "sample fill operation",
        );
        return capturedExecution(
          captureJsonValue(outcome.result, new WeakSet()), outcome.sampleProvenance,
        );
      }
    case "starter.seed":
      if (executionInstant === null)
        throw invalid("trusted starter seed instant is unavailable");
      if (sampleProvenanceCoordinates(store, operationId).length !== 0)
        throw invalid(STARTER_SEED_PREFIX + "operation provenance already exists");
      {
        const outcome = executeCapturedStarterSeed(
          store, request.payload, executionInstant, operationId,
        );
        const expected = request.payload.tables.reduce(
          (total, table) => total + table.sampleRows.length, 0,
        );
        const persisted = sampleProvenanceCoordinates(store, operationId);
        assertExactSampleProvenance(
          outcome.sampleProvenance, persisted, expected, STARTER_SEED_PREFIX + "operation",
        );
        return capturedExecution(outcome.result, outcome.sampleProvenance);
      }
    case "attachment.add":
      return capturedExecution(captureJsonValue(executeCapturedAttachmentAdd(store, {
        table: request.payload.table,
        rowId: request.payload.rowId,
        field: request.payload.field,
        name: request.payload.name,
        mime: request.payload.mime,
        bytes: new Uint8Array(request.payload.bytes.bytes),
      }, request.payload.bytes.sha256), new WeakSet()));
    case "attachment.remove":
      STORE_REMOVE_ATTACHMENT.call(
        store,
        request.payload.table,
        request.payload.rowId,
        request.payload.field,
        request.payload.id,
      );
      return capturedExecution(null);
    case "attachment.purge":
      if (executionInstant === null)
        throw invalid("trusted attachment purge instant is unavailable");
      return capturedExecution(captureJsonValue(STORE_PURGE_ATTACHMENTS.call(
        store, new Date(executionInstant), 30,
      ), new WeakSet()));
    case "batch.apply":
      return capturedExecution(captureJsonValue(STORE_APPLY_BATCH.call(store, {
        source: request.payload.source,
        summary: request.payload.summary,
        mutations: request.payload.mutations as unknown as
          Parameters<ClayStore["applyBatch"]>[0]["mutations"],
      }), new WeakSet()));
    case "batch.undo":
      return capturedExecution(captureJsonValue(
        STORE_UNDO_BATCH.call(store, request.payload.id), new WeakSet(),
      ));
    case "row.restore":
      return capturedExecution(captureJsonValue(STORE_RESTORE_ROW.call(
        store, request.payload.table, request.payload.id,
      ), new WeakSet()));
    case "schema.removeColumn": {
      const table = request.payload.table;
      const column = request.payload.column;
      STORE_COMMIT.call(store, {
        intent: `remove ${table}.${column}`,
        summary: `Removed “${column}” from ${table}; its data is retained.`,
        semanticOrigin: "direct",
        migration: {
          operations: [{ op: "hide_column", table, column }],
          inverse: [{ op: "unhide_column", table, column }],
        },
        panels: [],
        diff: [{ kind: "change_field", detail: `${column} hidden on ${table}` }],
      });
      const registryJson = JSON.stringify([...STORE_REGISTRY_SNAPSHOT.call(store).values()]);
      return capturedExecution(captureJsonValue(
        JSON.parse(registryJson) as unknown, new WeakSet(),
      ));
    }
    case "setting.set":
      STORE_SET_SETTING.call(store, request.payload.key, request.payload.value);
      return capturedExecution(null);
    case "setting.delete":
      STORE_DELETE_SETTING.call(store, request.payload.key);
      return capturedExecution(null);
    case "setting.compareAndSet": {
      const current: unknown = STORE_GET_SETTING.call(store, request.payload.key);
      const revision = current && typeof current === "object"
        && Number.isSafeInteger((current as { revision?: unknown }).revision)
        ? Number((current as { revision: number }).revision) : 0;
      if (revision !== request.payload.expectedRevision)
        return capturedExecution(captureJsonValue(
          { ok: false, current: current ?? null }, new WeakSet(),
        ));
      STORE_SET_SETTING.call(store, request.payload.key, request.payload.value);
      return capturedExecution(captureJsonValue(
        { ok: true, current: request.payload.value }, new WeakSet(),
      ));
    }
    case "firstSuccess.completeEveryday":
      return capturedExecution(executeFirstSuccessEveryday(store, request.payload));
    case "upsertAutomation":
    case "saveAutomationDraft":
    case "saveAutomationRecipeDraft":
    case "enableAutomation":
    case "pauseAutomation":
    case "deleteAutomation":
    case "runAutomationNow":
    case "runDueAutomations":
    case "undoAutomationRun":
    case "markNotificationRead":
    case "recordUsage":
    case "acceptSuggestion":
    case "dismissSuggestion":
      return capturedExecution(captureJsonValue(executeAutomationObserverAuthorityRoute(
        store, request.route, request.payload, executionInstant, automationTarget(expectedTarget),
        transactionCapability,
      ), new WeakSet()));
    case "intake.saveForm":
      return capturedExecution(captureJsonValue(STORE_SAVE_INTAKE_FORM.call(
        store,
        request.payload.form as unknown as Parameters<ClayStore["saveIntakeForm"]>[0],
      ), new WeakSet()));
    case "intake.closePublication":
      return capturedExecution(captureJsonValue(STORE_CLOSE_INTAKE_PUBLICATION.call(
        store, LocalIntakeFormV2.parse(request.payload.form), executionInstant ?? undefined,
      ), new WeakSet()));
    case "intake.markPublished":
      return capturedExecution(captureJsonValue(STORE_MARK_INTAKE_FORM_PUBLISHED.call(
        store, request.payload.formId, request.payload.publishedAt,
      ), new WeakSet()));
    case "intake.revokeForm":
      return capturedExecution(captureJsonValue(STORE_REVOKE_INTAKE_FORM.call(
        store, request.payload.formId, request.payload.revokedAt,
      ), new WeakSet()));
    case "intake.markExpired":
      return capturedExecution(captureJsonValue(STORE_MARK_INTAKE_FORM_EXPIRED.call(
        store, request.payload.formId, request.payload.expiredAt,
      ), new WeakSet()));
    case "intake.stageSubmission":
      return capturedExecution(captureJsonValue(STORE_STAGE_INTAKE.call(
        store,
        request.payload.submission as unknown as Parameters<ClayStore["stageIntakeSubmission"]>[0],
      ), new WeakSet()));
    case "intake.recordDeliveryFailure":
      return capturedExecution(captureJsonValue(STORE_RECORD_INTAKE_DELIVERY_FAILURE.call(
        store,
        request.payload.failure as unknown as Parameters<ClayStore["recordIntakeDeliveryFailure"]>[0],
      ), new WeakSet()));
    case "intake.authorizeDeliveryDiscard":
      return capturedExecution(captureJsonValue(STORE_AUTHORIZE_INTAKE_DELIVERY_DISCARD.call(
        store, request.payload.formId, request.payload.submissionId, request.payload.authorizedAt,
      ), new WeakSet()));
    case "intake.resolveDeliveryFailure":
      return capturedExecution(captureJsonValue(STORE_RESOLVE_INTAKE_DELIVERY_FAILURE.call(
        store, request.payload.formId, request.payload.submissionId,
        request.payload.resolution, request.payload.resolvedAt,
      ), new WeakSet()));
    case "intake.rejectSubmission":
      return capturedExecution(captureJsonValue(STORE_REJECT_INTAKE.call(
        store, request.payload.submissionId,
      ), new WeakSet()));
    case "intake.simulateAutoAccept":
      return capturedExecution(captureJsonValue(STORE_SIMULATE_INTAKE_AUTO.call(
        store,
        request.payload.draft as unknown as Parameters<ClayStore["simulateIntakeAutoAccept"]>[0],
      ), new WeakSet()));
    case "intake.enableAutoAccept":
      return capturedExecution(captureJsonValue(STORE_ENABLE_INTAKE_AUTO.call(store, {
        draft: request.payload.draft as unknown as Parameters<ClayStore["enableIntakeAutoAccept"]>[0]["draft"],
        simulationFingerprint: request.payload.simulationFingerprint,
      }), new WeakSet()));
    case "intake.disableAutoAccept":
      STORE_DISABLE_INTAKE_AUTO.call(store, request.payload.formId);
      return capturedExecution(null);
    case "intake.processAutoAccept":
      return capturedExecution(captureJsonValue(STORE_PROCESS_INTAKE_AUTO.call(
        store, request.payload.formId,
      ), new WeakSet()));
    case "intake.acceptSubmission":
      return capturedExecution(captureJsonValue(STORE_ACCEPT_INTAKE.call(store, {
        submissionId: request.payload.submissionId,
        mode: request.payload.mode,
        approvedFileIds: [...request.payload.approvedFileIds],
      }), new WeakSet()));
    case "intake.undoReceipt":
      return capturedExecution(captureJsonValue(STORE_UNDO_INTAKE.call(
        store, request.payload.receiptId,
      ), new WeakSet()));
  }
}

function executeCapturedOperationalMetricMutation(
  store: ClayStore,
  request: CapturedOperationalMetricMutation,
): JsonValue {
  return captureJsonValue(executePrivateMetricAuthorityRoute(
    store, request.route, request.payload,
  ), new WeakSet());
}

function copyResult(input: JsonValue): JsonValue {
  return captureJsonValue(input, new WeakSet());
}

function mutationResult(
  requestId: string,
  operationId: string,
  changed: boolean,
  replayed: boolean,
  evidence: TargetEvidence,
  result: JsonValue,
): ProductionMutationResult {
  return {
    requestId,
    operationId,
    changed,
    replayed,
    evidence: copyTarget(evidence),
    result: copyResult(result),
  };
}

function receiptTarget(
  receipt: PersistedProductionRequestReceipt,
  result: boolean,
  digestSchema: TargetEvidence["digestSchema"],
): TargetEvidence {
  return copyTarget({
    appInstanceId: receipt.appInstanceId,
    activeGenerationId: receipt.activeGenerationId,
    lineageEpoch: receipt.lineageEpoch,
    protectionRevision: result
      ? receipt.resultingProtectionRevision! : receipt.expectedProtectionRevision,
    digestSchema,
    stateSha256: result ? receipt.resultingStateSha256! : receipt.expectedStateSha256,
  });
}

function preparedReceipt(
  request: CapturedProductionMutation,
  fingerprint: string,
  expected: TargetEvidence,
  operationId: string,
  preparedAt: string,
): ProductionRequestReceipt {
  return {
    schema: 1,
    requestId: request.requestId,
    operationId,
    requestSha256: fingerprint,
    appInstanceId: expected.appInstanceId,
    activeGenerationId: expected.activeGenerationId,
    lineageEpoch: expected.lineageEpoch,
    expectedProtectionRevision: expected.protectionRevision,
    expectedStateSha256: expected.stateSha256,
    state: "prepared",
    resultingProtectionRevision: null,
    resultingStateSha256: null,
    responseSha256: null,
    preparedAt,
    invokedAt: null,
    completedAt: null,
  };
}

function invokedReceipt(
  prepared: ProductionRequestReceipt,
  invokedAt: string,
): ProductionRequestReceipt {
  const { responseJson: _discard, ...receipt } = prepared as ProductionRequestReceipt & {
    responseJson?: unknown;
  };
  return { ...receipt, state: "invoked", invokedAt };
}

function terminalReceipt(
  prior: ProductionRequestReceipt,
  state: "committed" | "no_op" | "failed",
  resulting: TargetEvidence,
  responseSha256: string,
  completedAt: string,
): ProductionRequestReceipt {
  const { responseJson: _discard, ...receipt } = prior as ProductionRequestReceipt & {
    responseJson?: unknown;
  };
  return {
    ...receipt,
    state,
    resultingProtectionRevision: resulting.protectionRevision,
    resultingStateSha256: resulting.stateSha256,
    responseSha256,
    completedAt,
  };
}

function canonicalChanges(
  before: ReturnType<typeof enumerateCanonicalStateV1>,
  after: ReturnType<typeof enumerateCanonicalStateV1>,
): StateMerkleChange[] {
  const beforeByKey = new Map(before.leaves.map(entry =>
    [entry.seed.key, stateLeafHashV1(entry.seed.key, entry.seed.fields)]));
  const changes: StateMerkleChange[] = [];
  for (const entry of after.leaves) {
    const prior = beforeByKey.get(entry.seed.key);
    const next = stateLeafHashV1(entry.seed.key, entry.seed.fields);
    if (prior !== next) changes.push({ key: entry.seed.key, fields: entry.seed.fields });
    beforeByKey.delete(entry.seed.key);
  }
  for (const key of beforeByKey.keys()) changes.push({ key, fields: null });
  changes.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  if (changes.length === 0 && before.stateSha256 !== after.stateSha256)
    throw invalid("canonical mutation diff is inconsistent");
  return changes;
}

export function commitCopiedSampleReattestation(input: Readonly<{
  driver: DbDriver; store: ClayStore; fence: WriteFence; expectedCatalogGeneration: string;
  expectedTarget: TargetEvidence; requestId: string; nowMs: number;
  sourceSha256: string; sourceAuthorityIncarnationId: string; kind: "restore" | "fork";
}>): TargetEvidence {
  const expected = copyTarget(input.expectedTarget);
  const request: CapturedProductionMutation = { requestId: RequestId.parse(input.requestId),
    route: input.kind === "restore" ? "archive.restore.samples" : "app.fork.samples",
    payload: { sourceSha256: input.sourceSha256,
      sourceAuthorityIncarnationId: input.sourceAuthorityIncarnationId, sourceTargetStateSha256: expected.stateSha256 } };
  assertCapturedMutationBytes(request);
  const at = trustedInstant(() => input.nowMs);
  const catalog = DeviceCatalog.openExisting(input.driver);
  const target = TargetAuthorityStore.open(input.driver);
  catalog.assertWriteFence(input.fence, at.milliseconds);
  if (catalog.snapshot().catalogGeneration !== input.expectedCatalogGeneration
      || !sameTarget(catalog.selectedTargetStorage().target, expected) || !sameTarget(target.evidence(), expected))
    throw invalid("restored sample target is stale");
  const before = enumerateCanonicalStateV1(input.driver, input.store.validationRegistrySnapshot());
  if (before.stateSha256 !== expected.stateSha256) throw invalid("restored sample prestate is not canonical");
  const operationId = productionOperationIdV2(input.fence.authorityIncarnationId, request.requestId, request.route);
  const fingerprint = requestFingerprint(expected, request);
  target.reserveProtectionRevision(operationId, at.instant, expected, fingerprint);
  const reserved = catalog.reserveSelectedProtectionRevision({
    expectedCatalogGeneration: input.expectedCatalogGeneration, expectedTarget: expected,
    operationId, requestSha256: fingerprint, fence: input.fence, nowMs: at.milliseconds,
  });
  const prepared = preparedReceipt(request, fingerprint, expected, operationId, at.instant);
  writeProductionRequestReceipt(input.driver, prepared, null, null);
  const invoked = invokedReceipt(prepared, at.instant);
  writeProductionRequestReceipt(input.driver, invoked, null, "prepared");
  const execution = executeCopiedSampleReattestation(input.store, operationId, input.sourceSha256, input.sourceAuthorityIncarnationId, input.kind);
  const after = enumerateCanonicalStateV1(input.driver, input.store.validationRegistrySnapshot());
  const changes = canonicalChanges(before, after);
  if (!changes.length) throw invalid("restored sample re-attestation changed no state");
  const encoded = encodeProductionResponse(request.route, execution.result, execution.sampleProvenance);
  const committed = target.commitReservedProtectionRevision({ operationId, expectedTarget: expected,
    finalizedAt: at.instant, changes, requestSha256: fingerprint, mutate: () => undefined, registry: input.store.validationRegistrySnapshot() });
  catalog.publishSelectedTarget({ expectedCatalogGeneration: reserved.reservedCatalogGeneration,
    expectedTarget: expected, publishedTarget: committed, operationId, requestSha256: fingerprint,
    fence: input.fence, nowMs: at.milliseconds });
  writeProductionRequestReceipt(input.driver, terminalReceipt(invoked, "committed", committed, encoded.sha256, at.instant), encoded.json, "invoked");
  assertLiveSampleProvenance(input.driver, input.store, committed);
  return copyTarget(committed);
}

class SimulatedInvocationCrash extends Error {
  constructor() { super("simulated crash after durable invocation"); }
}

export type ProductionMutationTestFailure =
  | "live_mutation"
  | "after_live_mutation"
  | "stale_fence"
  | "abandonment_unavailable"
  | "crash_after_invocation"
  | "after_live_mutation";
const TEST_FAILURE = new WeakMap<
  ProductionMutationCoordinator, ProductionMutationTestFailure
>();
const TEST_FAIL_ABANDONMENT = new WeakSet<ProductionMutationCoordinator>();

/** Source-private test seam. Not exported from any package entrypoint. */
export function armProductionMutationFailureForTest(
  coordinator: ProductionMutationCoordinator,
  failure: ProductionMutationTestFailure = "live_mutation",
): void {
  TEST_FAILURE.set(coordinator, failure);
}

/** Package-private: only ProductionStoreAuthority can construct this coordinator. */
export type ProductionBackupSelection = Readonly<{
  selected: BackupSelectedTarget;
  fence: WriteFence;
}>;

export class ProductionMutationCoordinator {
  readonly #driver: DbDriver;
  readonly #writeAuthority: LiveWriteAuthority;
  readonly #store: ClayStore;
  #fence: WriteFence;
  readonly #leaseTtlMs: number;
  readonly #clock: () => number;
  #poisoned = false;
  #catalogGeneration: string;
  #target: TargetEvidence;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    driver: DbDriver,
    writeAuthority: LiveWriteAuthority,
    store: ClayStore,
    fence: WriteFence,
    catalogGeneration: string,
    target: TargetEvidence,
    leaseTtlMs: number,
    clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1)
      throw invalid("production lease TTL is invalid");
    this.#driver = driver;
    this.#writeAuthority = writeAuthority;
    this.#store = store;
    this.#fence = Object.freeze({ ...fence });
    this.#leaseTtlMs = leaseTtlMs;
    this.#catalogGeneration = catalogGeneration;
    this.#target = copyTarget(target);
    this.#clock = clock;
  }

  mintRequestId(): string {
    return mintProductionAuthorityId("req");
  }

  execute(input: unknown): Promise<ProductionMutationResult> {
    if (this.#poisoned)
      return Promise.reject(invalid("production authority is poisoned; reopen for reservation recovery"));
    // Capture before queueing: caller-owned accessors and arrays are never retained.
    const captured = captureMutation(input);
    assertCapturedMutationBytes(captured);
    const run = this.#tail.then(() => {
      if (this.#poisoned)
        throw invalid("production authority is poisoned; reopen for reservation recovery");
      return this.#executeCaptured(captured);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run.then(result => { assertIntakeResponsePublic(captured.route, result.result); return result; });
  }

  /** Serialize an authority-owned read behind prior writes and ahead of later writes. */
  serializeRead<T>(read: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => {
      if (this.#poisoned)
        throw invalid("production authority is poisoned; reopen for reservation recovery");
      return read();
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  backupSelection(expectedInput?: ProductionBackupSelection["selected"]): Promise<ProductionBackupSelection> {
    const expected = expectedInput === undefined ? undefined : BackupSelectedTargetV1.parse(expectedInput);
    const run = this.#tail.then(() => {
      if (this.#poisoned)
        throw invalid("production authority is poisoned; reopen for reservation recovery");
      this.#ensureWriteFence();
      const catalog = DeviceCatalog.openExisting(this.#driver);
      const snapshot = catalog.snapshot();
        const target = catalog.selectedTargetStorage().target;
        if (expected && (expected.authorityIncarnationId !== snapshot.authorityIncarnationId
            || !sameTarget(expected.target, target) || !catalog.hasOnlyLeaseSuffix(expected.catalogGeneration, target.appInstanceId)))
          throw new ClayError("E_GENERATION_NOT_SELECTED", "backup candidate cannot cross a non-lease catalog change");
      if (snapshot.selectedAppInstanceId === null
          || snapshot.selectedAppInstanceId !== target.appInstanceId
          || snapshot.catalogGeneration !== this.#catalogGeneration
          || snapshot.writeEpoch !== this.#fence.writeEpoch
          || !sameTarget(target, this.#target))
        throw new ClayError("E_GENERATION_NOT_SELECTED", "backup target is not current");
      return Object.freeze({
        selected: BackupSelectedTargetV1.parse({
          schema: 1,
          authorityIncarnationId: snapshot.authorityIncarnationId,
          catalogGeneration: snapshot.catalogGeneration,
          selectedAppInstanceId: snapshot.selectedAppInstanceId,
          selectedActiveGenerationId: target.activeGenerationId,
          writeEpoch: snapshot.writeEpoch,
          target,
        }),
        fence: Object.freeze({ ...this.#fence }),
      });
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  backupRecords(allApps = false): Promise<BackupRecord[]> {
    return this.serializeRead(async () => {
      const catalog = DeviceCatalog.openExisting(this.#driver);
      return catalog.backupRecords(allApps ? undefined : this.#target.appInstanceId);
    });
  }

  backupRetentionPlan(input: unknown) {
    const captured = structuredClone(input);
    return this.serializeRead(async () => DeviceCatalog.openExisting(this.#driver).backupRetentionPlan(captured));
  }
  backupRetentionHistory() {
    return this.serializeRead(async () => DeviceCatalog.openExisting(this.#driver).backupRetentionHistory());
  }
  authorizeBackupRemoval(input: unknown) {
    const captured = BackupRemovalRequestV1.parse(input);
    return this.serializeRead(async () => {
      this.#ensureWriteFence();
      return DeviceCatalog.openExisting(this.#driver).authorizeBackupRemoval(captured, this.#fence, trustedInstant(this.#clock).milliseconds);
    });
  }
  acknowledgeBackupRemoval(input: unknown, fence: WriteFence) {
    const captured = BackupRemovalAcknowledgementV1.parse(input); const requestedFence = { ...fence };
    return this.serializeRead(async () => {
      this.#ensureWriteFence();
      const catalog = DeviceCatalog.openExisting(this.#driver);
      return this.#writeAuthority.run(() => catalog.acknowledgeBackupRemoval({ ...captured,
        fence: requestedFence, nowMs: trustedInstant(this.#clock).milliseconds }));
    });
  }

  /** Historical acknowledgement, NOT a mutation replay. It does not claim the
   * effect is still current or authorize an Undo across intervening writes. */
  mutationOutcome(input: unknown): Promise<PresentationMutationOutcomeV1> {
    const captured = captureMutation(input); RecoverablePresentationRouteV1.parse(captured.route);
    return this.serializeRead(async () => this.#presentationOutcome(captured));
  }

  /** Serialized against invocation. A terminal no-effect receipt closes the old
   * ID even if its non-cancelling browser timeout can still deliver it later. */
  cancelPresentation(input: unknown): Promise<PresentationMutationOutcomeV1> {
    const captured = captureMutation(input);
    if (captured.route !== "daily.capture" && captured.route !== "schema.convertTextToRelation"
        && captured.route !== "daily.undoCapture" && captured.route !== "schema.undoRelationConversion"
        && captured.route !== "daily.source" && captured.route !== "daily.navigation"
        && captured.route !== "daily.inbox" && captured.route !== "daily.undoInbox"
        && captured.route !== "automation.command" && captured.route !== "intake.command")
      throw invalid("Only explicitly enumerated source-bound presentation commands can be cancelled here");
    return this.serializeRead(async () => {
      this.#ensureWriteFence();
      const outcome = this.#presentationOutcome(captured);
      if (outcome.status !== "not_invoked") return outcome;
      const source = captured.route === "daily.source" || captured.route === "daily.navigation" || captured.route === "daily.inbox"
        ? captured.payload.review.authorityTarget.appInstanceId
        : captured.route === "daily.capture" ? captured.payload.appInstanceId
        : captured.route === "schema.undoRelationConversion" ? originalPresentationResult(this.#driver, this.#target,
          captured.payload.conversionRequestId, "schema.convertTextToRelation").target.appInstanceId
        : captured.payload.authorityTarget.appInstanceId;
      if (source !== this.#target.appInstanceId) throw invalid("Cancellation belongs to another app");
      if (captured.route === "daily.undoCapture") originalPresentationResult(this.#driver, this.#target,
        captured.payload.captureRequestId, "daily.capture", captured.payload.capturePayload);
      if (captured.route === "daily.undoInbox") originalPresentationResult(this.#driver, this.#target,
        captured.payload.actionRequestId, "daily.inbox", captured.payload.actionPayload);
      this.#executeNoOp(captured, this.#target, this.#catalogGeneration, { kind: "clay-presentation-cancelled-v1" });
      const readback = this.#presentationOutcome(captured);
      if (readback.status !== "cancelled") throw invalid("Presentation cancellation failed terminal readback");
      return readback;
    });
  }

  #presentationOutcome(captured: CapturedProductionMutation): PresentationMutationOutcomeV1 {
      const catalog = DeviceCatalog.openExisting(this.#driver);
      const current = TargetAuthorityStore.open(this.#driver).evidence();
      if (!sameTarget(current, this.#target) || !sameTarget(catalog.selectedTargetStorage().target, current)
          || catalog.snapshot().selectedAppInstanceId !== current.appInstanceId
          || enumerateCanonicalStateV1(this.#driver, this.#store.validationRegistrySnapshot()).stateSha256 !== current.stateSha256)
        throw invalid("Presentation recovery source is not the current canonical app");
      const receipt = readProductionRequestReceipt(this.#driver, captured.requestId);
      if (!receipt) return { status: "not_invoked" };
      const expected = receiptTarget(receipt, false, current.digestSchema);
      if (expected.appInstanceId !== current.appInstanceId || expected.activeGenerationId !== current.activeGenerationId
          || expected.lineageEpoch !== current.lineageEpoch
          || receipt.operationId !== productionOperationIdV2(catalog.snapshot().authorityIncarnationId, captured.requestId, captured.route)
          || receipt.requestSha256 !== requestFingerprint(expected, captured))
        throw invalid("Presentation request identity or payload binding is invalid");
      if (receipt.state === "invoked" || receipt.state === "prepared") return { status: "uncertain" };
      if (receipt.responseJson === null || receipt.resultingProtectionRevision === null || receipt.resultingStateSha256 === null)
        throw invalid("Presentation receipt is incomplete");
      const decoded = decodeProductionResponse(receipt.responseJson);
      assertIntakeResponsePublic(captured.route, decoded.result);
      if (decoded.kind !== "envelope" || decoded.route !== captured.route) throw invalid("Presentation receipt route differs");
      if (receipt.state === "failed") {
        const physical = TargetAuthorityStore.open(this.#driver).reservations().find(row => row.operationId === receipt.operationId);
        const mirrored = catalog.revisionReservations().find(row => row.operationId === receipt.operationId);
        if (!physical || !mirrored || physical.state !== "abandoned" || mirrored.state !== "abandoned"
            || physical.revision !== mirrored.revision || physical.requestSha256 !== receipt.requestSha256
            || mirrored.requestSha256 !== receipt.requestSha256
            || physical.expectedProtectionRevision !== receipt.expectedProtectionRevision
            || mirrored.expectedProtectionRevision !== receipt.expectedProtectionRevision
            || physical.expectedStateSha256 !== receipt.expectedStateSha256 || mirrored.expectedStateSha256 !== receipt.expectedStateSha256
            || receipt.resultingProtectionRevision !== receipt.expectedProtectionRevision || receipt.resultingStateSha256 !== receipt.expectedStateSha256)
          throw invalid("Failed presentation request lacks proven abandoned effects");
        return { status: "failed" };
      }
      if (receipt.state === "no_op" && JSON.stringify(decoded.result) === '{"kind":"clay-presentation-cancelled-v1"}')
        return { status: "cancelled" };
      if (receipt.state === "committed") assertCommittedReceiptReservationBinding(receipt,
        TargetAuthorityStore.open(this.#driver).reservations(), catalog.revisionReservations());
      const target = receiptTarget(receipt, true, current.digestSchema);
      return { status: "recorded", current: sameTarget(current, target), result: decoded.result, target };
  }

  publishBackup(input: BackupPublicationRequest): Promise<BackupPublicationReceipt> {
    const captured = BackupPublicationRequestV1.parse(input);
    const run = this.#tail.then(() => {
      if (this.#poisoned)
        throw invalid("production authority is poisoned; reopen for reservation recovery");
      this.#ensureWriteFence();
      const now = trustedInstant(this.#clock).milliseconds;
      const catalog = DeviceCatalog.openExisting(this.#driver);
      const receipt = this.#writeAuthority.run(() => catalog.publishBackup({
        request: captured,
        operationId: mintProductionAuthorityId("op"),
        nowMs: now,
      }));
      const after = catalog.snapshot();
      const selected = catalog.selectedTargetStorage().target;
      if (!sameTarget(selected, this.#target)
          || after.selectedAppInstanceId !== this.#target.appInstanceId
          || after.writeEpoch !== this.#fence.writeEpoch)
        throw invalid("backup publication changed the selected production target");
      this.#catalogGeneration = after.catalogGeneration;
      return receipt;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  replayPlannerDecision(
    requestIdInput: unknown,
    decisionInput: unknown,
  ): Promise<ProductionMutationResult> {
    if (this.#poisoned)
      return Promise.reject(invalid("production authority is poisoned; reopen for reservation recovery"));
    const parsedRequestId = RequestId.safeParse(requestIdInput);
    if (!parsedRequestId.success || (decisionInput !== "keep" && decisionInput !== "discard"))
      return Promise.reject(invalid("planner decision replay identity is invalid"));
    const requestId = parsedRequestId.data;
    const route = decisionInput === "keep" ? "planner.keep" : "planner.discard";
    const run = this.#tail.then(() => {
      if (this.#poisoned)
        throw invalid("production authority is poisoned; reopen for reservation recovery");
      const replayed = this.#durablePlannerDecisionReplay(requestId, route);
      if (!replayed)
        throw new ClayError("E_CONFLICT", "no durable planner decision matches the request");
      return replayed;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  simulateAutomation(input: unknown): Promise<AutomationSimulationProofV1> {
    if (this.#poisoned)
      return Promise.reject(invalid("production authority is poisoned; reopen for reservation recovery"));
    const captured = captureAutomationSimulation(input);
    const run = this.#tail.then(() => {
      if (this.#poisoned)
        throw invalid("production authority is poisoned; reopen for reservation recovery");
      return this.#simulateAutomationCaptured(captured);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  executeOperationalMetric(input: unknown): Promise<ProductionMutationResult> {
    if (this.#poisoned)
      return Promise.reject(invalid("production authority is poisoned; reopen for reservation recovery"));
    const captured = captureOperationalMetricMutation(input);
    const run = this.#tail.then(() => {
      if (this.#poisoned)
        throw invalid("production authority is poisoned; reopen for reservation recovery");
      return this.#executeOperationalCaptured(captured);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #supersedeFenceForTest(): void {
    if (TEST_FAILURE.get(this) !== "stale_fence") return;
    TEST_FAILURE.delete(this);
    const nowMs = trustedInstant(this.#clock).milliseconds;
    const before = DeviceCatalog.openExisting(this.#driver).snapshot();
    this.#writeAuthority.run(() => {
      DeviceCatalog.openExisting(this.#driver).acquireWriteLease({
        expectedAuthorityIncarnationId: before.authorityIncarnationId,
        expectedCatalogGeneration: before.catalogGeneration,
        expectedWriteEpoch: before.writeEpoch,
        releaseId: mintProductionAuthorityId("rel"),
        nowMs,
        ttlMs: this.#leaseTtlMs,
      });
    });
  }

  #ensureWriteFence(): void {
    const now = trustedInstant(this.#clock).milliseconds;
    const catalog = DeviceCatalog.openExisting(this.#driver);
    const snapshot = catalog.snapshot();
    if (snapshot.authorityIncarnationId !== this.#fence.authorityIncarnationId
        || snapshot.catalogGeneration !== this.#catalogGeneration
        || snapshot.writeEpoch !== this.#fence.writeEpoch
        || !sameTarget(catalog.selectedTargetStorage().target, this.#target))
      throw new ClayError("E_STALE_WRITE_EPOCH", "production worker lease is stale");
    try {
      catalog.assertWriteFence(this.#fence, now);
      return;
    } catch {
      const confirmed = catalog.snapshot();
      if (confirmed.authorityIncarnationId !== this.#fence.authorityIncarnationId
          || confirmed.catalogGeneration !== this.#catalogGeneration
          || confirmed.writeEpoch !== this.#fence.writeEpoch)
        throw new ClayError("E_STALE_WRITE_EPOCH", "production worker lease was superseded");
      const renewed = this.#writeAuthority.run(() => catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: confirmed.authorityIncarnationId,
        expectedCatalogGeneration: confirmed.catalogGeneration,
        expectedWriteEpoch: confirmed.writeEpoch,
        releaseId: this.#fence.releaseId,
        nowMs: now,
        ttlMs: this.#leaseTtlMs,
      }));
      this.#fence = Object.freeze({ ...renewed });
      this.#catalogGeneration = catalog.snapshot().catalogGeneration;
    }
  }

  #authorityState(
    expected: TargetEvidence,
    catalogGeneration: string,
    nowMs: number | null,
    message: string,
    generationError = true,
  ): { catalog: DeviceCatalog; target: TargetAuthorityStore } {
    const catalog = DeviceCatalog.openExisting(this.#driver);
    const target = TargetAuthorityStore.open(this.#driver);
    if (nowMs !== null) catalog.assertWriteFence(this.#fence, nowMs);
    if (catalog.snapshot().catalogGeneration !== catalogGeneration
        || !sameTarget(catalog.selectedTargetStorage().target, expected)
        || !sameTarget(target.evidence(), expected))
      throw generationError ? new ClayError("E_GENERATION_NOT_SELECTED", message) : invalid(message);
    return { catalog, target };
  }

  #simulateAutomationCaptured(
    request: CapturedAutomationSimulation,
  ): AutomationSimulationProofV1 {
    const expected = copyTarget(this.#target);
    this.#authorityState(
      expected,
      this.#catalogGeneration,
      null,
      "production automation target is stale",
    );
    const canonical = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (canonical.stateSha256 !== expected.stateSha256)
      throw invalid("production automation simulation prestate is not canonical");
    const clock = trustedInstant(this.#clock);
    const storeRequest: AutomationSimulationRequestV1 = {
      id: request.id,
      target: automationTarget(expected),
      expectedRevision: request.expectedRevision,
      purpose: request.purpose,
    };
    return this.#store.simulateAutomation(storeRequest, new Date(clock.milliseconds));
  }

  async #executeCaptured(request: CapturedProductionMutation): Promise<ProductionMutationResult> {
    const outcome = this.#durableReceiptReplay(request);
    if (outcome) return outcome;
    const durable = this.#durableReplay(request);
    if (durable) return durable;
    this.#supersedeFenceForTest();
    this.#ensureWriteFence();
    const executionInstant = request.route === "starter.seed"
        || request.route.startsWith("daily.")
        || request.route === "automation.command"
        || request.route.startsWith("intake.")
        || request.route === "attachment.purge"
        || request.route === "saveAutomationDraft"
        || request.route === "saveAutomationRecipeDraft"
        || request.route === "enableAutomation"
        || request.route === "pauseAutomation"
        || request.route === "runAutomationNow"
        || request.route === "runDueAutomations"
      ? trustedInstant(this.#clock).instant : null;

    const expected = copyTarget(this.#target);
    const operationId = productionOperationIdV2(
      this.#fence.authorityIncarnationId, request.requestId, request.route,
    );
    const expectedCatalogGeneration = this.#catalogGeneration;
    const { catalog: catalogBefore } = this.#authorityState(
      expected,
      expectedCatalogGeneration,
      null,
      PRODUCTION_MUTATION_PREFIX + "target is stale",
    );
    const liveBefore = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (liveBefore.stateSha256 !== expected.stateSha256)
      throw invalid(PRODUCTION_MUTATION_PREFIX + "prestate is not canonical");
    const sampleLedgerCertificate = usesSampleProvenance(request.route)
      ? assertLiveSampleProvenance(this.#driver, this.#store, expected) : null;

    const shadowDriver = await this.#driver.snapshot();
    let shadow: ClayStore | null = null;
    let shadowChanged = false;
    let shadowResult: JsonValue = null;
    try {
      shadow = ClayStore.fromDriver(shadowDriver);
      const shadowBefore = enumerateCanonicalStateV1(
        shadowDriver, shadow.validationRegistrySnapshot(),
      );
      if (shadowBefore.stateSha256 !== liveBefore.stateSha256)
        throw invalid(PRODUCTION_MUTATION_PREFIX + "snapshot is not canonical");
      if (sampleLedgerCertificate !== null) {
        const shadowLedger = STORE_SAMPLE_PROVENANCE.call(shadow).map(entry => ({
          tableId: entry.tableId,
          rowId: entry.rowId,
          operationId: entry.operationId,
        }));
        if (JSON.stringify(shadowLedger) !== JSON.stringify(sampleLedgerCertificate))
          throw invalid(PRODUCTION_MUTATION_PREFIX + "sample proof changed in shadow capture");
      }
      const preparedExecution = executeCapturedMutation(
        shadow, request, executionInstant, operationId, expected,
        automationPhysicalTransactionCapability(this.#driver),
        // Request journals are not installed in disposable data previews.
        // The bounded Undo reader uses the real mirrored receipt; it never writes it.
        this.#driver,
      );
      if (isThenable(preparedExecution)) throw invalid(PRODUCTION_MUTATION_PREFIX + "must be synchronous");
      shadowResult = copyResult(preparedExecution.result);
      encodeProductionResponse(
        request.route, shadowResult, preparedExecution.sampleProvenance,
      );
      const shadowAfter = enumerateCanonicalStateV1(
        shadowDriver, shadow.validationRegistrySnapshot(),
      );
      shadowChanged = canonicalChanges(shadowBefore, shadowAfter).length > 0;
    } finally {
      try {
        if (shadow) shadow.close();
        else shadowDriver.close();
      } catch { /* disposable snapshot */ }
    }

    const execute = () => !shadowChanged
      ? this.#executeNoOp(
        request, expected, expectedCatalogGeneration, shadowResult,
      ) : this.#executeMeaningful(
        request, expected, expectedCatalogGeneration, executionInstant, operationId,
      );
    return requiresAutomationPhysicalTransaction(request.route)
      ? withAutomationPhysicalTransaction(this.#driver, execute) : execute();
  }

  async #executeOperationalCaptured(
    request: CapturedOperationalMetricMutation,
  ): Promise<ProductionMutationResult> {
    // Device-local telemetry is explicitly outside canonical production state.
    // It therefore cannot use a canonical no-op receipt or reserve a target
    // revision; this fixed path instead proves the canonical target unchanged
    // around one guarded physical transaction.
    if (readProductionRequestReceipt(this.#driver, request.requestId))
      throw invalid("operational metric identity collides with a production request");
    this.#supersedeFenceForTest();
    this.#ensureWriteFence();
    const expected = copyTarget(this.#target);
    const expectedCatalogGeneration = this.#catalogGeneration;
    this.#authorityState(
      expected, expectedCatalogGeneration, null, "operational metric target is stale",
    );
    const liveCanonical = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (liveCanonical.stateSha256 !== expected.stateSha256)
      throw invalid("operational metric prestate is not canonical");
    const operationalBefore = privateMetricOperationalFingerprint(this.#driver);

    const shadowDriver = await this.#driver.snapshot();
    let shadow: ClayStore | null = null;
    let changed = false;
    let result: JsonValue = null;
    try {
      shadow = ClayStore.fromDriver(shadowDriver);
      copyPrivateMetricOperationalState(this.#driver, shadowDriver);
      const shadowCanonical = enumerateCanonicalStateV1(
        shadowDriver, shadow.validationRegistrySnapshot(),
      );
      if (shadowCanonical.stateSha256 !== liveCanonical.stateSha256
          || privateMetricOperationalFingerprint(shadowDriver) !== operationalBefore)
        throw invalid("operational metric snapshot is not exact");
      result = copyResult(executeCapturedOperationalMetricMutation(shadow, request));
      const shadowAfter = enumerateCanonicalStateV1(
        shadowDriver, shadow.validationRegistrySnapshot(),
      );
      if (canonicalChanges(shadowCanonical, shadowAfter).length > 0)
        throw invalid("fixed operational metric reached canonical state");
      changed = privateMetricOperationalFingerprint(shadowDriver) !== operationalBefore;
    } finally {
      try {
        if (shadow) shadow.close();
        else shadowDriver.close();
      } catch { /* disposable snapshot */ }
    }

    if (!changed) return this.#executeOperationalNoOp(
      request, expected, expectedCatalogGeneration, result, operationalBefore,
    );
    return this.#executeOperationalMeaningful(
      request, expected, expectedCatalogGeneration, operationalBefore,
    );
  }

  #durableReceiptReplay(
    request: CapturedProductionMutation,
  ): ProductionMutationResult | null {
    const persisted = readProductionRequestReceipt(this.#driver, request.requestId);
    if (!persisted) return null;
    const expected = receiptTarget(persisted, false, this.#target.digestSchema);
    const fingerprint = requestFingerprint(expected, request);
    const starterShellId = request.route === "starter.seed" ? request.payload.shellId : null;
    return this.#terminalReceiptReplay(
      persisted, request.requestId, request.route, fingerprint, starterShellId,
    );
  }

  #durablePlannerDecisionReplay(
    requestId: string,
    route: "planner.keep" | "planner.discard",
  ): ProductionMutationResult | null {
    const persisted = readProductionRequestReceipt(this.#driver, requestId);
    if (!persisted) return null;
    if (persisted.state === "no_op")
      throw invalid("durable planner decision has an invalid terminal state");
    return this.#terminalReceiptReplay(persisted, requestId, route, null, null);
  }

  #terminalReceiptReplay(
    persisted: PersistedProductionRequestReceipt,
    requestId: string,
    route: CapturedProductionMutation["route"],
    expectedRequestSha256: string | null,
    starterShellId: string | null,
  ): ProductionMutationResult {
    const expected = receiptTarget(persisted, false, this.#target.digestSchema);
    if (expectedRequestSha256 !== null && expectedRequestSha256 !== persisted.requestSha256)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "identity was reused for another mutation");
    const expectedOperationV1 = productionOperationIdV1(
      this.#fence.authorityIncarnationId, requestId,
    );
    const expectedOperationV2 = productionOperationIdV2(
      this.#fence.authorityIncarnationId, requestId, route,
    );
    if (persisted.operationId !== expectedOperationV2
        && (expectedRequestSha256 === null || persisted.operationId !== expectedOperationV1))
      throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt operation identity is invalid");
    if (persisted.state === "prepared")
      throw invalid("prepared production request requires explicit recovery");
    if (persisted.state === "invoked")
      throw invalid(PRODUCTION_REQUEST_PREFIX + "was already invoked and its result is ambiguous");
    if (persisted.resultingProtectionRevision === null
        || persisted.resultingStateSha256 === null || persisted.responseJson === null)
      throw invalid("terminal production request receipt is incomplete");
    const decodedResponse = decodeProductionResponse(persisted.responseJson);
    if (decodedResponse.kind === "envelope") {
      if (decodedResponse.route !== route
          || persisted.operationId !== expectedOperationV2)
        throw invalid(PRODUCTION_REQUEST_PREFIX + "response route binding is invalid");
    } else if (expectedRequestSha256 === null || persisted.operationId !== expectedOperationV1) {
      throw invalid("legacy production response operation identity is invalid");
    }
      const response = decodedResponse.result;
      if (persisted.state === "no_op" && JSON.stringify(response) === '{"kind":"clay-presentation-cancelled-v1"}')
        throw invalid("Presentation request was cancelled; the old ID can never execute");
    const resulting = receiptTarget(persisted, true, this.#target.digestSchema);
    const catalog = DeviceCatalog.openExisting(this.#driver);
    const targetAuthority = TargetAuthorityStore.open(this.#driver);
    const current = targetAuthority.evidence();
    const canonical = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (!sameTarget(current, resulting))
      throw invalid("historical production request receipt is not independently auditable");
    if (!sameTarget(catalog.selectedTargetStorage().target, resulting)
        || !sameTarget(this.#target, resulting)
        || catalog.snapshot().catalogGeneration !== this.#catalogGeneration
        || canonical.stateSha256 !== resulting.stateSha256)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt failed current-state read-back");
    if (persisted.state === "committed") {
      assertCommittedReceiptReservationBinding(
        persisted, targetAuthority.reservations(), catalog.revisionReservations(),
      );
    }
    if (decodedResponse.kind === "envelope" && usesSampleProvenance(route))
      assertLiveSampleProvenance(this.#driver, this.#store, resulting);
    if (route === "starter.seed" && starterShellId !== null
        && (selectedCatalogShell(catalog, resulting) !== starterShellId
          || STORE_GET_SETTING.call(this.#store, "shell_id") !== starterShellId))
      throw invalid("production starter seed shell metadata failed replay read-back");
    if (persisted.state === "failed") {
      const message = response !== null && !Array.isArray(response)
        && typeof response === "object" && typeof response.message === "string"
        ? response.message : PRODUCTION_REQUEST_PREFIX + "failed previously";
      throw invalid(`production request failed previously: ${message}`);
    }
    return mutationResult(
      requestId,
      persisted.operationId,
      persisted.state === "committed",
      true,
      resulting,
      response,
    );
  }

  #durableReplay(request: CapturedProductionMutation): ProductionMutationResult | null {
    const operationIds = new Set([
      productionOperationIdV2(
        this.#fence.authorityIncarnationId, request.requestId, request.route,
      ),
      productionOperationIdV1(this.#fence.authorityIncarnationId, request.requestId),
    ]);
    const catalog = DeviceCatalog.openExisting(this.#driver);
    const target = TargetAuthorityStore.open(this.#driver);
    const targetRows = target.reservations()
      .filter(candidate => operationIds.has(candidate.operationId));
    const catalogRows = catalog.revisionReservations()
      .filter(candidate => operationIds.has(candidate.operationId));
    if (targetRows.length === 0 && catalogRows.length === 0) return null;
    if (targetRows.length !== 1 || catalogRows.length !== 1)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "has incomplete mirrored journal evidence");
    const targetRow = targetRows[0]!;
    const catalogRow = catalogRows[0]!;
    if (targetRow.operationId !== catalogRow.operationId
        || targetRow.revision !== catalogRow.revision
        || targetRow.requestSha256 !== catalogRow.requestSha256
        || targetRow.expectedProtectionRevision !== catalogRow.expectedProtectionRevision
        || targetRow.expectedStateSha256 !== catalogRow.expectedStateSha256)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "mirrored journal evidence disagrees");
    const originalExpected = copyTarget({
      appInstanceId: catalogRow.appInstanceId,
      activeGenerationId: catalogRow.activeGenerationId,
      lineageEpoch: catalogRow.lineageEpoch,
      protectionRevision: catalogRow.expectedProtectionRevision,
      digestSchema: this.#target.digestSchema,
      stateSha256: catalogRow.expectedStateSha256,
    });
    const fingerprint = requestFingerprint(originalExpected, request);
    if (targetRow.requestSha256 !== fingerprint)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "identity was reused for another mutation");
    if (targetRow.state !== catalogRow.state)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "mirrored journal states disagree");
    if (targetRow.state === "abandoned")
      throw invalid(PRODUCTION_REQUEST_PREFIX + "was permanently abandoned");
    if (targetRow.state !== "committed")
      throw invalid(PRODUCTION_REQUEST_PREFIX + "requires reservation recovery");
    if (!targetRow.stateSha256 || !catalogRow.stateSha256
        || !catalogRow.publishedActiveGenerationId || !catalogRow.publishedLineageEpoch)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "committed evidence is incomplete");
    const committed = copyTarget({
      appInstanceId: catalogRow.appInstanceId,
      activeGenerationId: catalogRow.publishedActiveGenerationId,
      lineageEpoch: catalogRow.publishedLineageEpoch,
      protectionRevision: targetRow.revision,
      digestSchema: this.#target.digestSchema,
      stateSha256: targetRow.stateSha256,
    });
    if (catalogRow.stateSha256 !== committed.stateSha256)
      throw invalid(PRODUCTION_REQUEST_PREFIX + "committed target evidence disagrees");
    const currentTarget = target.evidence();
    if (!sameTarget(currentTarget, committed))
      throw invalid("historical committed evidence is not independently auditable");
    const selected = catalog.selectedTargetStorage().target;
    const canonical = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (!sameTarget(selected, committed) || !sameTarget(this.#target, committed)
        || catalog.snapshot().catalogGeneration !== this.#catalogGeneration
        || canonical.stateSha256 !== committed.stateSha256)
      throw invalid("production durable replay failed current-state read-back");
    throw invalid("committed production request outcome evidence is missing");
  }

  #executeNoOp(
    request: CapturedProductionMutation,
    expected: TargetEvidence,
    expectedCatalogGeneration: string,
    result: JsonValue,
  ): ProductionMutationResult {
    const operationId = productionOperationIdV2(
      this.#fence.authorityIncarnationId, request.requestId, request.route,
    );
    const fingerprint = requestFingerprint(expected, request);
    const encoded = encodeProductionResponse(
      request.route, result, isSampleProducingRoute(request.route) ? [] : undefined,
    );
    this.#writeAuthority.run(() => {
      const at = trustedInstant(this.#clock);
      this.#authorityState(
        expected, expectedCatalogGeneration, at.milliseconds, "production no-op target is stale",
      );
      const canonical = enumerateCanonicalStateV1(
        this.#driver, this.#store.validationRegistrySnapshot(),
      );
      if (canonical.stateSha256 !== expected.stateSha256)
        throw invalid("production no-op prestate is not canonical");
      const prepared = preparedReceipt(
        request, fingerprint, expected, operationId, at.instant,
      );
      writeProductionRequestReceipt(
        this.#driver,
        terminalReceipt(prepared, "no_op", expected, encoded.sha256, at.instant),
        encoded.json,
        null,
      );
    });
    return mutationResult(request.requestId, operationId, false, false, expected, result);
  }

  #assertFixedOperationalPrestate(
    expected: TargetEvidence,
    expectedCatalogGeneration: string,
    expectedOperationalFingerprint: string,
    nowMs: number,
  ): void {
    this.#authorityState(
      expected,
      expectedCatalogGeneration,
      nowMs,
      FIXED_OPERATIONAL_MUTATION_PREFIX + "target is stale",
    );
    const canonical = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (canonical.stateSha256 !== expected.stateSha256)
      throw invalid(FIXED_OPERATIONAL_MUTATION_PREFIX + "prestate is not canonical");
    if (privateMetricOperationalFingerprint(this.#driver) !== expectedOperationalFingerprint)
      throw invalid(FIXED_OPERATIONAL_MUTATION_PREFIX + "prestate changed");
  }

  #executeOperationalNoOp(
    request: FixedOperationalMutation,
    expected: TargetEvidence,
    expectedCatalogGeneration: string,
    result: JsonValue,
    expectedOperationalFingerprint: string,
  ): ProductionMutationResult {
    const at = trustedInstant(this.#clock);
    this.#assertFixedOperationalPrestate(
      expected, expectedCatalogGeneration, expectedOperationalFingerprint, at.milliseconds,
    );
    return mutationResult(
      request.requestId,
      operationIdForOperationalMetric(this.#fence.authorityIncarnationId, request.requestId),
      false,
      false,
      expected,
      result,
    );
  }

  #executeOperationalMeaningful(
    request: FixedOperationalMutation,
    expected: TargetEvidence,
    expectedCatalogGeneration: string,
    expectedOperationalFingerprint: string,
  ): ProductionMutationResult {
    let result: JsonValue = null;
    this.#writeAuthority.run(() => {
      const at = trustedInstant(this.#clock);
      this.#assertFixedOperationalPrestate(
        expected, expectedCatalogGeneration, expectedOperationalFingerprint, at.milliseconds,
      );
      const testFailure = TEST_FAILURE.get(this);
      if (testFailure && testFailure !== "after_live_mutation") {
        TEST_FAILURE.delete(this);
        throw invalid("injected fixed operational mutation failure");
      }
      result = executeCapturedOperationalMetricMutation(this.#store, request);
      if (isThenable(result)) throw invalid(FIXED_OPERATIONAL_MUTATION_PREFIX + "must be synchronous");
      if (TEST_FAILURE.get(this) === "after_live_mutation") {
        TEST_FAILURE.delete(this);
        throw invalid("injected failure after live mutation");
      }
      const canonical = enumerateCanonicalStateV1(
        this.#driver, this.#store.validationRegistrySnapshot(),
      );
      if (canonical.stateSha256 !== expected.stateSha256
          || !sameTarget(TargetAuthorityStore.open(this.#driver).evidence(), expected))
        throw invalid(FIXED_OPERATIONAL_MUTATION_PREFIX + "reached canonical target state");
      const catalog = DeviceCatalog.openExisting(this.#driver);
      if (catalog.snapshot().catalogGeneration !== expectedCatalogGeneration
          || !sameTarget(catalog.selectedTargetStorage().target, expected))
        throw invalid(FIXED_OPERATIONAL_MUTATION_PREFIX + "reached catalog authority");
      if (privateMetricOperationalFingerprint(this.#driver) === expectedOperationalFingerprint)
        throw invalid(FIXED_OPERATIONAL_MUTATION_PREFIX + "became a no-op");
    });
    return mutationResult(
      request.requestId,
      operationIdForOperationalMetric(this.#fence.authorityIncarnationId, request.requestId),
      true,
      false,
      expected,
      result,
    );
  }

  #executeMeaningful(
    request: CapturedProductionMutation,
    expected: TargetEvidence,
    expectedCatalogGeneration: string,
    executionInstant: string | null,
    operationId: string,
  ): ProductionMutationResult {
    const fingerprint = requestFingerprint(expected, request);
    let reservedCatalogGeneration: string | null = null;
    let prepared: ProductionRequestReceipt | null = null;
    let result: JsonValue = null;
    let resultSampleProvenance: readonly SampleProvenanceCoordinate[] | undefined;
    let liveTransactionAttempted = false;
    try {
      const reservation = this.#writeAuthority.run(() => {
        const at = trustedInstant(this.#clock);
        const { catalog, target } = this.#authorityState(
          expected,
          expectedCatalogGeneration,
          at.milliseconds,
          PRODUCTION_MUTATION_PREFIX + "target is stale",
        );
        const canonical = enumerateCanonicalStateV1(
          this.#driver, this.#store.validationRegistrySnapshot(),
        );
        if (canonical.stateSha256 !== expected.stateSha256)
          throw invalid(PRODUCTION_MUTATION_PREFIX + "prestate changed before reservation");
        const targetReservation = target.reserveProtectionRevision(
          operationId, at.instant, expected, fingerprint,
        );
        const catalogReservation = catalog.reserveSelectedProtectionRevision({
          expectedCatalogGeneration,
          expectedTarget: expected,
          operationId,
          requestSha256: fingerprint,
          fence: this.#fence,
          nowMs: at.milliseconds,
        });
        const receipt = preparedReceipt(
          request, fingerprint, expected, operationId, at.instant,
        );
        writeProductionRequestReceipt(this.#driver, receipt, null, null);
        const persistedTarget = target.reservations()
          .find(candidate => candidate.operationId === operationId);
        const persistedCatalog = catalog.revisionReservations()
          .find(candidate => candidate.operationId === operationId);
        if (targetReservation.state !== "reserved" || catalogReservation.state !== "reserved"
            || !persistedTarget || !persistedCatalog
            || persistedTarget.state !== "reserved" || persistedCatalog.state !== "reserved"
            || persistedTarget.revision !== persistedCatalog.revision
            || persistedTarget.revision !== targetReservation.revision
            || persistedTarget.requestSha256 !== fingerprint
            || persistedCatalog.requestSha256 !== fingerprint)
          throw invalid(PRODUCTION_MUTATION_PREFIX + "reservation failed read-back");
        return {
          receipt,
          catalogGeneration: catalogReservation.reservedCatalogGeneration,
        };
      });
      prepared = reservation.receipt;
      reservedCatalogGeneration = reservation.catalogGeneration;

      const invoked = this.#writeAuthority.run(() => {
        const at = trustedInstant(this.#clock);
        const { catalog, target } = this.#authorityState(
          expected,
          reservedCatalogGeneration!,
          at.milliseconds,
          PRODUCTION_MUTATION_PREFIX + "target changed before invocation",
          false,
        );
        const targetReservation = target.reservations()
          .find(candidate => candidate.operationId === operationId);
        const catalogReservation = catalog.revisionReservations()
          .find(candidate => candidate.operationId === operationId);
        if (!targetReservation || !catalogReservation
            || targetReservation.state !== "reserved" || catalogReservation.state !== "reserved")
          throw invalid("production invocation reservation is unavailable");
        const persisted = readProductionRequestReceipt(this.#driver, request.requestId);
        if (!persisted || persisted.state !== "prepared")
          throw invalid(PRODUCTION_REQUEST_PREFIX + "was not durably prepared");
        const next = invokedReceipt(persisted, at.instant);
        writeProductionRequestReceipt(this.#driver, next, null, "prepared");
        return next;
      });

      const testFailure = TEST_FAILURE.get(this);
      if (testFailure && testFailure !== "after_live_mutation") {
        TEST_FAILURE.delete(this);
        if (testFailure === "crash_after_invocation") {
          this.#poisoned = true;
          throw new SimulatedInvocationCrash();
        }
        if (testFailure === "abandonment_unavailable") TEST_FAIL_ABANDONMENT.add(this);
        throw new Error("injected after reservation");
      }

      liveTransactionAttempted = true;
      const committedState = this.#writeAuthority.run(() => {
        const at = trustedInstant(this.#clock);
        const { catalog, target } = this.#authorityState(
          expected,
          reservedCatalogGeneration!,
          at.milliseconds,
          PRODUCTION_MUTATION_PREFIX + "target is stale",
        );
        const persistedReceipt = readProductionRequestReceipt(this.#driver, request.requestId);
        if (!persistedReceipt || persistedReceipt.state !== "invoked"
            || persistedReceipt.operationId !== operationId)
          throw invalid("production invocation marker is unavailable");
        const before = enumerateCanonicalStateV1(
          this.#driver, this.#store.validationRegistrySnapshot(),
        );
        if (before.stateSha256 !== expected.stateSha256)
          throw invalid(PRODUCTION_MUTATION_PREFIX + "prestate changed before commit");
        const execution = executeCapturedMutation(
          this.#store, request, executionInstant, operationId, expected,
          automationPhysicalTransactionCapability(this.#driver),
          this.#driver,
        );
        if (isThenable(execution)) throw invalid(PRODUCTION_MUTATION_PREFIX + "must be synchronous");
        result = execution.result;
        resultSampleProvenance = execution.sampleProvenance;
        if (TEST_FAILURE.get(this) === "after_live_mutation") {
          TEST_FAILURE.delete(this);
          throw invalid("injected failure after live mutation");
        }
        if (request.route === "starter.seed"
            && STORE_GET_SETTING.call(this.#store, "shell_id") !== request.payload.shellId)
          throw invalid(STARTER_SEED_PREFIX + "system shell metadata failed read-back");
        const publicationMetadata = request.route === "starter.seed" ? (() => {
          const app = catalog.snapshot().entries.find(candidate =>
            candidate.appInstanceId === expected.appInstanceId);
          if (!app) throw invalid(STARTER_SEED_PREFIX + "catalog app metadata is unavailable");
          const seedMetadata = starterSeedCatalogMetadata(request.payload);
          return Object.freeze({
            displayName: app.displayName,
            shellId: seedMetadata.shellId,
          });
        })() : undefined;
        const after = enumerateCanonicalStateV1(
          this.#driver, this.#store.validationRegistrySnapshot(),
        );
        const changes = canonicalChanges(before, after);
        if (changes.length === 0)
          throw invalid("meaningful production mutation became a no-op");
        const encodedResult = encodeProductionResponse(
          request.route, result, resultSampleProvenance,
        );
        const committedTarget = target.commitReservedProtectionRevision({
          operationId,
          expectedTarget: expected,
          finalizedAt: at.instant,
          changes,
          requestSha256: fingerprint,
          mutate: () => undefined,
          registry: this.#store.validationRegistrySnapshot(),
        });
        const publicationInput = {
          expectedCatalogGeneration: reservedCatalogGeneration!,
          expectedTarget: expected,
          publishedTarget: committedTarget,
          operationId,
          requestSha256: fingerprint,
          fence: this.#fence,
          nowMs: at.milliseconds,
          ...(publicationMetadata === undefined ? {} : { metadata: publicationMetadata }),
        };
        catalog.publishSelectedTarget(publicationInput);
        if (request.route === "starter.seed"
            && selectedCatalogShell(catalog, committedTarget) !== request.payload.shellId)
          throw invalid(STARTER_SEED_PREFIX + "catalog shell metadata failed read-back");
        writeProductionRequestReceipt(
          this.#driver,
          terminalReceipt(
            invoked, "committed", committedTarget, encodedResult.sha256, at.instant,
          ),
          encodedResult.json,
          "invoked",
        );
        if (usesSampleProvenance(request.route))
          assertLiveSampleProvenance(this.#driver, this.#store, committedTarget);
        const targetRow = target.reservations()
          .find(candidate => candidate.operationId === operationId);
        const catalogRow = catalog.revisionReservations()
          .find(candidate => candidate.operationId === operationId);
        const receipt = readProductionRequestReceipt(this.#driver, request.requestId);
        const canonical = enumerateCanonicalStateV1(
          this.#driver, this.#store.validationRegistrySnapshot(),
        );
        const finalCatalog = catalog.snapshot();
        const finalShell = request.route === "starter.seed"
          ? finalCatalog.entries.find(candidate =>
              candidate.appInstanceId === committedTarget.appInstanceId)?.shellId
          : null;
        if (!targetRow || !catalogRow || !receipt
            || targetRow.state !== "committed" || catalogRow.state !== "committed"
            || receipt.state !== "committed"
            || targetRow.operationId !== operationId || catalogRow.operationId !== operationId
            || receipt.operationId !== operationId
            || targetRow.revision !== catalogRow.revision
            || targetRow.requestSha256 !== fingerprint
            || catalogRow.requestSha256 !== fingerprint
            || receipt.requestSha256 !== fingerprint
            || canonical.stateSha256 !== committedTarget.stateSha256
            || !sameTarget(catalog.selectedTargetStorage().target, committedTarget)
            || (request.route === "starter.seed" && finalShell !== request.payload.shellId)
            || finalCatalog.catalogGeneration
              !== (BigInt(reservedCatalogGeneration!) + 1n).toString())
          throw invalid(PRODUCTION_MUTATION_PREFIX + "failed mirrored canonical read-back");
        return { target: committedTarget, catalogGeneration: finalCatalog.catalogGeneration };
      });

      const committed = committedState.target;
      this.#target = copyTarget(committed);
      this.#catalogGeneration = committedState.catalogGeneration;
      return mutationResult(request.requestId, operationId, true, false, committed, result);
    } catch (error) {
      if (error instanceof SimulatedInvocationCrash) throw error;
      try {
        STORE_RELOAD_AFTER_ROLLBACK.call(this.#store);
      } catch {
        this.#poisoned = true;
        throw invalid("production Store could not refresh after transaction rollback");
      }
      if (reservedCatalogGeneration !== null && prepared !== null) {
        try {
          this.#recordAbandonment(
            operationId,
            request.requestId,
            request.route,
            fingerprint,
            expected,
            reservedCatalogGeneration!,
            error,
          );
        } catch (abandonmentError) {
          this.#poisoned = true;
          throw abandonmentError;
        }
      }
      if (liveTransactionAttempted) {
        try {
          refreshStoreAfterPhysicalRollback(this.#store);
        } catch {
          this.#poisoned = true;
          throw invalid(PRODUCTION_MUTATION_PREFIX + "rollback recovery requires reopen");
        }
      }
      throw error;
    }
  }

  #recordAbandonment(
    operationId: string,
    requestId: string,
    route: string,
    fingerprint: string,
    expected: TargetEvidence,
    reservedCatalogGeneration: string,
    error: unknown,
  ): void {
    try {
      if (TEST_FAIL_ABANDONMENT.delete(this))
        throw invalid(PRODUCTION_MUTATION_PREFIX + "failed and reservation recovery is required");
      const failure: JsonValue = {
        code: error instanceof ClayError ? error.code : "E_INTERNAL",
        message: error instanceof Error
          ? error.message.slice(0, 1_000) : PRODUCTION_MUTATION_PREFIX + "failed",
      };
      const encoded = encodeProductionResponse(
        route, failure, isSampleProducingRoute(route) ? [] : undefined,
      );
      const at = trustedInstant(this.#clock);
      this.#writeAuthority.run(() => {
        const { catalog, target } = this.#authorityState(
          expected,
          reservedCatalogGeneration!,
          at.milliseconds,
          "failed operation target changed before abandonment",
          false,
        );
        const targetReservation = target.reservations()
          .find(candidate => candidate.operationId === operationId);
        const catalogReservation = catalog.revisionReservations()
          .find(candidate => candidate.operationId === operationId);
        const receipt = readProductionRequestReceipt(this.#driver, requestId);
        if (!targetReservation || !catalogReservation || !receipt
            || targetReservation.state !== "reserved" || catalogReservation.state !== "reserved"
            || targetReservation.revision !== catalogReservation.revision
            || targetReservation.requestSha256 !== fingerprint
            || catalogReservation.requestSha256 !== fingerprint
            || receipt.operationId !== operationId || receipt.requestSha256 !== fingerprint
            || (receipt.state !== "prepared" && receipt.state !== "invoked"))
          throw invalid("failed operation durable preparation is unavailable");
        target.abandonProtectionRevision(operationId, at.instant);
        catalog.abandonSelectedProtectionRevision({
          expectedCatalogGeneration: reservedCatalogGeneration,
          expectedTarget: expected,
          operationId,
          requestSha256: fingerprint,
          fence: this.#fence,
          nowMs: at.milliseconds,
        });
        writeProductionRequestReceipt(
          this.#driver,
          terminalReceipt(receipt, "failed", expected, encoded.sha256, at.instant),
          encoded.json,
          receipt.state,
        );
        const targetAfter = target.reservations()
          .find(candidate => candidate.operationId === operationId);
        const catalogAfter = catalog.revisionReservations()
          .find(candidate => candidate.operationId === operationId);
        const receiptAfter = readProductionRequestReceipt(this.#driver, receipt.requestId);
        if (!targetAfter || !catalogAfter || !receiptAfter
            || targetAfter.state !== "abandoned" || catalogAfter.state !== "abandoned"
            || receiptAfter.state !== "failed"
            || targetAfter.revision !== catalogAfter.revision
            || receiptAfter.operationId !== operationId)
          throw invalid("failed operation abandonment did not mirror");
      });
      this.#catalogGeneration = DeviceCatalog.openExisting(this.#driver)
        .snapshot().catalogGeneration;
    } catch {
      throw invalid(PRODUCTION_MUTATION_PREFIX + "failed and reservation recovery is required");
    }
  }
}

export { captureMutation as captureMutationOracle };
