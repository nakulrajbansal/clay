import { OperationId } from "@clay/schema";
import {
  TargetEvidenceV1,
  type ProductionRequestReceiptV1 as ProductionRequestReceipt,
  type TargetEvidenceV1 as TargetEvidence,
  type WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import { enumerateCanonicalStateV1 } from "./canonical-state";
import { isThenable, type DbDriver } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { ClayError } from "./errors";
import type { LiveWriteAuthority } from "./live-write-guard";
import { executeAutomationObserverAuthorityRoute } from "./production-automation-observer-routes";
import {
  copyPrivateMetricOperationalState,
  executePrivateMetricAuthorityRoute,
  privateMetricOperationalFingerprint,
} from "./production-private-metric-authority";
import {
  readProductionRequestReceipt,
  writeProductionRequestReceipt,
} from "./production-request-journal";
import {
  captureStarterSeedBundle,
  executeCapturedStarterSeed,
  starterSeedCatalogMetadata,
  type CapturedStarterSeedBundle,
} from "./production-seed";
import { sha256HexSync } from "./state-digest";
import { stateLeafHashV1 } from "./state-merkle";
import type { StateMerkleChange } from "./state-merkle-index";
import { ClayStore, executeCapturedAttachmentAdd } from "./store";
import { TargetAuthorityStore } from "./target-authority";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
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

type CapturedProductionMutation = Readonly<{
  requestId: string;
} & (
  | { route: "store.insert"; payload: Readonly<{ table: string; row: Readonly<JsonRecord> }> }
  | {
    route: "store.update";
    payload: Readonly<{ table: string; id: string; patch: Readonly<JsonRecord> }>;
  }
  | { route: "store.softDelete"; payload: Readonly<{ table: string; id: string }> }
  | { route: "store.commit"; payload: Readonly<{ plan: Readonly<JsonRecord> }> }
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
  | { route: "upsertAutomation"; payload: Readonly<{ input: Readonly<JsonRecord> }> }
  | { route: "deleteAutomation"; payload: Readonly<{ id: string }> }
  | { route: "runAutomationNow"; payload: Readonly<{ id: string }> }
  | { route: "runDueAutomations"; payload: Readonly<JsonRecord> }
  | { route: "undoAutomationRun"; payload: Readonly<{ id: string }> }
  | { route: "markNotificationRead"; payload: Readonly<{ id: string }> }
  | { route: "recordUsage"; payload: Readonly<{ event: Readonly<JsonRecord> }> }
  | { route: "acceptSuggestion"; payload: Readonly<{ subject: string; kind: string }> }
  | { route: "dismissSuggestion"; payload: Readonly<{ subject: string; kind: string }> }
)>;

type CapturedOperationalMetricMutation = Readonly<{
  requestId: string;
} & (
  | { route: "recordPrivateMetric"; payload: Readonly<{ event: Readonly<JsonRecord> }> }
  | { route: "setPrivateMetricsEnabled"; payload: Readonly<{ enabled: boolean }> }
  | { route: "clearPrivateMetrics"; payload: Readonly<JsonRecord> }
)>;

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

function assertSettingKeyAvailable(key: string): void {
  if (key === "shell_id")
    throw invalid("reserved setting 'shell_id' may only be changed by starter activation");
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
    throw invalid("production mutation envelope must be a plain data record");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw invalid("production mutation envelope must be a plain data record");
  const allowed = ["requestId", "route", "payload"] as const;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowed.length
      || keys.some(key => typeof key !== "string"
        || !allowed.includes(key as typeof allowed[number])))
    throw invalid("production mutation envelope fields are invalid");
  const values: Record<typeof allowed[number], unknown> = {
    requestId: undefined,
    route: undefined,
    payload: undefined,
  };
  for (const key of allowed) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw invalid("production mutation envelope fields must be plain data properties");
    values[key] = descriptor.value;
  }
  return Object.freeze(values);
}

const MAX_CAPTURE_DEPTH = 64;
const MAX_CAPTURE_NODES = 100_000;
const MAX_CAPTURE_ARRAY = 10_000;
const MAX_CAPTURE_KEYS = 10_000;
const MAX_CAPTURE_KEY_LENGTH = 128;
const MAX_CAPTURE_STRING = 1_000_000;
const MAX_CAPTURE_BYTES = 2_000_000;
const CAPTURE_ENCODER = new TextEncoder();

type CaptureBudget = { nodes: number; bytes: number };

function consumeCaptureBytes(
  budget: CaptureBudget,
  bytes: number,
  subject: "payload" | "binary payload" = "payload",
): void {
  budget.bytes += bytes;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_CAPTURE_BYTES)
    throw unavailable(`production mutation ${subject} exceeds aggregate limits`);
}

function chargeCaptureBytes(byteLength: number, budget: CaptureBudget): void {
  consumeCaptureBytes(budget, byteLength);
}

function chargeCaptureText(value: string, budget: CaptureBudget, framingBytes = 0): void {
  consumeCaptureBytes(budget, CAPTURE_ENCODER.encode(value).byteLength + framingBytes);
}

function chargeRecordFrame(keys: readonly string[], budget: CaptureBudget): void {
  chargeCaptureBytes(2 + Math.max(0, keys.length - 1), budget);
  for (const key of keys) chargeCaptureText(key, budget, 3);
}

function captureJsonValue(
  input: unknown,
  seen: WeakSet<object>,
  depth = 0,
  budget: CaptureBudget = { nodes: 0, bytes: 0 },
): JsonValue {
  if (depth > MAX_CAPTURE_DEPTH || ++budget.nodes > MAX_CAPTURE_NODES)
    throw unavailable("production mutation payload exceeds limits");
  if (input === null) {
    consumeCaptureBytes(budget, 4);
    return input;
  }
  if (typeof input === "boolean") {
    consumeCaptureBytes(budget, input ? 4 : 5);
    return input;
  }
  if (typeof input === "string") {
    if (input.length > MAX_CAPTURE_STRING)
      throw unavailable("production mutation payload exceeds limits");
    consumeCaptureBytes(budget, new TextEncoder().encode(JSON.stringify(input)).byteLength);
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    consumeCaptureBytes(budget, new TextEncoder().encode(JSON.stringify(input)).byteLength);
    return input;
  }
  if (typeof input !== "object") throw new Error("invalid JSON value");
  if (seen.has(input)) throw new Error("cyclic JSON value");
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      if (Reflect.getPrototypeOf(input) !== Array.prototype)
        throw new Error("invalid array");
      const keys = Reflect.ownKeys(input);
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(input, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || (lengthDescriptor.value as number) < 0
          || (lengthDescriptor.value as number) > MAX_CAPTURE_ARRAY)
        throw unavailable("production mutation payload exceeds limits");
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1 || keys.some(key => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })) throw new Error("invalid array keys");
      consumeCaptureBytes(budget, 2 + Math.max(0, length - 1));
      const output = new Array<JsonValue>(length);
      for (let index = 0; index < length; index++) {
        const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw new Error("invalid array item");
        output[index] = captureJsonValue(descriptor.value, seen, depth + 1, budget);
      }
      return Object.freeze(output) as JsonValue[];
    }
    const prototype = Reflect.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid record");
    const output: JsonRecord = Object.create(null) as JsonRecord;
    const keys = Reflect.ownKeys(input);
    if (keys.length > MAX_CAPTURE_KEYS || keys.some(key =>
      typeof key !== "string" || key.length > MAX_CAPTURE_KEY_LENGTH))
      throw unavailable("production mutation payload exceeds limits");
    consumeCaptureBytes(budget, 2 + Math.max(0, keys.length - 1));
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new Error("invalid record property");
      consumeCaptureBytes(
        budget,
        new TextEncoder().encode(JSON.stringify(key)).byteLength + 1,
      );
      output[key] = captureJsonValue(descriptor.value, seen, depth + 1, budget);
    }
    return Object.freeze(output);
  } finally {
    seen.delete(input);
  }
}

function captureExactDataFields(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)
      || (Reflect.getPrototypeOf(input) !== Object.prototype
        && Reflect.getPrototypeOf(input) !== null)) throw new Error();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowed.length || keys.some(key =>
    typeof key !== "string" || !allowed.includes(key))) throw new Error();
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
    output[key] = descriptor.value;
  }
  return output;
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

function capturedJsonRecord(input: JsonValue | undefined): Readonly<JsonRecord> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("expected record");
  return input;
}

function captureBatchMutations(
  input: unknown,
  budget: CaptureBudget,
): readonly CapturedBatchMutation[] {
  const captured = captureJsonValue(input, new WeakSet(), 0, budget);
  if (!Array.isArray(captured) || captured.length < 1 || captured.length > 500)
    throw unavailable("production batch must contain 1 to 500 mutations");
  const output: CapturedBatchMutation[] = [];
  for (let index = 0; index < captured.length; index++) {
    const mutation = capturedJsonRecord(captured[index]);
    const kind = mutation.kind;
    if (kind === "insert") {
      const fields = captureExactDataFields(mutation, ["kind", "table", "row"]);
      if (typeof fields.table !== "string") throw new Error();
      output.push(Object.freeze({
        kind, table: fields.table, row: capturedJsonRecord(fields.row as JsonValue),
      }));
    } else if (kind === "update") {
      const fields = captureExactDataFields(mutation, ["kind", "table", "id", "patch"]);
      if (typeof fields.table !== "string" || typeof fields.id !== "string") throw new Error();
      output.push(Object.freeze({
        kind, table: fields.table, id: fields.id,
        patch: capturedJsonRecord(fields.patch as JsonValue),
      }));
    } else if (kind === "soft_delete" || kind === "restore") {
      const fields = captureExactDataFields(mutation, ["kind", "table", "id"]);
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

function captureMutation(input: unknown): CapturedProductionMutation {
  try {
    const envelope = captureMutationEnvelope(input);
    const requestId = envelope.requestId;
    const route = envelope.route;
    const payload = envelope.payload;
    if (typeof requestId !== "string" || !/^req_[a-z2-7]{26}$/.test(requestId)
        || typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    switch (route) {
      case "store.insert": {
        const fields = exactKeys(payload, ["table", "row"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["table", "row"], budget);
        const table = captureJsonValue(fields.table, new WeakSet(), 0, budget);
        const row = fields.row;
        if (typeof table !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({
          table, row: captureJsonRecord(row, budget),
        }) });
      }
      case "store.update": {
        const fields = exactKeys(payload, ["table", "id", "patch"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["table", "id", "patch"], budget);
        const table = captureJsonValue(fields.table, new WeakSet(), 0, budget);
        const id = captureJsonValue(fields.id, new WeakSet(), 0, budget);
        const patch = fields.patch;
        if (typeof table !== "string" || typeof id !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({
          table, id, patch: captureJsonRecord(patch, budget),
        }) });
      }
      case "store.softDelete": {
        const fields = exactKeys(payload, ["table", "id"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["table", "id"], budget);
        const table = captureJsonValue(fields.table, new WeakSet(), 0, budget);
        const id = captureJsonValue(fields.id, new WeakSet(), 0, budget);
        if (typeof table !== "string" || typeof id !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({ table, id }) });
      }
      case "store.commit": {
        const fields = exactKeys(payload, ["plan"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["plan"], budget);
        return Object.freeze({ requestId, route, payload: Object.freeze({
          plan: captureJsonRecord(fields.plan, budget),
        }) });
      }
      case "starter.seed":
        return Object.freeze({
          requestId,
          route,
          payload: captureStarterSeedBundle(payload),
        });
      case "attachment.add": {
        const fields = captureExactDataFields(
          payload, ["table", "rowId", "field", "name", "mime", "bytes"],
        );
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["table", "rowId", "field", "name", "mime", "bytes"], budget);
        const table = captureJsonValue(fields.table, new WeakSet(), 0, budget);
        const rowId = captureJsonValue(fields.rowId, new WeakSet(), 0, budget);
        const field = captureJsonValue(fields.field, new WeakSet(), 0, budget);
        const name = captureJsonValue(fields.name, new WeakSet(), 0, budget);
        const mime = captureJsonValue(fields.mime, new WeakSet(), 0, budget);
        if (typeof table !== "string" || typeof rowId !== "string"
            || typeof field !== "string" || typeof name !== "string"
            || typeof mime !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({
          table, rowId, field, name, mime,
          bytes: captureBinary(fields.bytes, budget),
        }) });
      }
      case "attachment.remove": {
        const fields = captureExactDataFields(
          payload, ["table", "rowId", "field", "id"],
        );
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["table", "rowId", "field", "id"], budget);
        const table = captureJsonValue(fields.table, new WeakSet(), 0, budget);
        const rowId = captureJsonValue(fields.rowId, new WeakSet(), 0, budget);
        const field = captureJsonValue(fields.field, new WeakSet(), 0, budget);
        const id = captureJsonValue(fields.id, new WeakSet(), 0, budget);
        if (typeof table !== "string" || typeof rowId !== "string"
            || typeof field !== "string" || typeof id !== "string") throw new Error();
        return Object.freeze({
          requestId, route, payload: Object.freeze({ table, rowId, field, id }),
        });
      }
      case "attachment.purge": {
        captureExactDataFields(payload, []);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame([], budget);
        return Object.freeze({ requestId, route, payload: Object.freeze({}) });
      }
      case "batch.apply": {
        const fields = exactKeys(payload, ["source", "summary", "mutations"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["source", "summary", "mutations"], budget);
        const source = captureJsonValue(fields.source, new WeakSet(), 0, budget);
        const summary = captureJsonValue(fields.summary, new WeakSet(), 0, budget);
        if ((source !== "user" && source !== "automation") || typeof summary !== "string")
          throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({
          source,
          summary,
          mutations: captureBatchMutations(fields.mutations, budget),
        }) });
      }
      case "batch.undo": {
        const fields = exactKeys(payload, ["id"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["id"], budget);
        const id = captureJsonValue(fields.id, new WeakSet(), 0, budget);
        if (typeof id !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({ id }) });
      }
      case "row.restore": {
        const fields = exactKeys(payload, ["table", "id"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["table", "id"], budget);
        const table = captureJsonValue(fields.table, new WeakSet(), 0, budget);
        const id = captureJsonValue(fields.id, new WeakSet(), 0, budget);
        if (typeof table !== "string" || typeof id !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({ table, id }) });
      }
      case "schema.removeColumn": {
        const fields = exactKeys(payload, ["table", "column"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["table", "column"], budget);
        const table = captureJsonValue(fields.table, new WeakSet(), 0, budget);
        const column = captureJsonValue(fields.column, new WeakSet(), 0, budget);
        if (typeof table !== "string" || typeof column !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({ table, column }) });
      }
      case "setting.set": {
        const fields = exactKeys(payload, ["key", "value"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["key", "value"], budget);
        const key = captureJsonValue(fields.key, new WeakSet(), 0, budget);
        const value = fields.value;
        if (typeof key !== "string") throw new Error();
        assertSettingKeyAvailable(key);
        return Object.freeze({ requestId, route, payload: Object.freeze({
          key, value: captureJsonValue(value, new WeakSet(), 0, budget),
        }) });
      }
      case "setting.delete": {
        const fields = exactKeys(payload, ["key"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["key"], budget);
        const key = captureJsonValue(fields.key, new WeakSet(), 0, budget);
        if (typeof key !== "string") throw new Error();
        assertSettingKeyAvailable(key);
        return Object.freeze({ requestId, route, payload: Object.freeze({ key }) });
      }
      case "setting.compareAndSet": {
        const fields = exactKeys(payload, ["key", "expectedRevision", "value"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["key", "expectedRevision", "value"], budget);
        const key = captureJsonValue(fields.key, new WeakSet(), 0, budget);
        const expectedRevision = captureJsonValue(
          fields.expectedRevision, new WeakSet(), 0, budget,
        );
        const value = fields.value;
        if (typeof key !== "string" || !Number.isSafeInteger(expectedRevision)
            || (expectedRevision as number) < 0) throw new Error();
        assertSettingKeyAvailable(key);
        return Object.freeze({ requestId, route, payload: Object.freeze({
          key,
          expectedRevision: expectedRevision as number,
          value: captureJsonValue(value, new WeakSet(), 0, budget),
        }) });
      }
      case "upsertAutomation": {
        const fields = exactKeys(payload, ["input"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["input"], budget);
        return Object.freeze({ requestId, route, payload: Object.freeze({
          input: captureJsonRecord(fields.input, budget),
        }) });
      }
      case "deleteAutomation":
      case "runAutomationNow":
      case "undoAutomationRun":
      case "markNotificationRead": {
        const fields = exactKeys(payload, ["id"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["id"], budget);
        const id = captureJsonValue(fields.id, new WeakSet(), 0, budget);
        if (typeof id !== "string") throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({ id }) });
      }
      case "runDueAutomations": {
        exactKeys(payload, []);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame([], budget);
        return Object.freeze({ requestId, route, payload: Object.freeze({}) });
      }
      case "recordUsage": {
        const fields = exactKeys(payload, ["event"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["event"], budget);
        return Object.freeze({ requestId, route, payload: Object.freeze({
          event: validateCapturedUsageEvent(captureJsonRecord(fields.event, budget)),
        }) });
      }
      case "acceptSuggestion":
      case "dismissSuggestion": {
        const fields = exactKeys(payload, ["subject", "kind"]);
        const budget: CaptureBudget = { nodes: 1, bytes: 0 };
        chargeRecordFrame(["subject", "kind"], budget);
        const subject = captureJsonValue(fields.subject, new WeakSet(), 0, budget);
        const kind = captureJsonValue(fields.kind, new WeakSet(), 0, budget);
        if (typeof subject !== "string" || subject.length < 1
            || typeof kind !== "string" || ![
              "promote_to_status", "pin_filtered_panel", "add_view", "flag_overdue",
              "regroup_board", "make_workflow", "chart_metric",
            ].includes(kind)) throw new Error();
        return Object.freeze({ requestId, route, payload: Object.freeze({
          subject, kind,
        }) });
      }
      default:
        throw new Error();
    }
  } catch (error) {
    if (error instanceof ClayError) throw error;
    throw invalid("production mutation request is invalid");
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

function stableJson(input: JsonValue): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) {
    let output = "[";
    for (let index = 0; index < input.length; index++)
      output += `${index === 0 ? "" : ","}${stableJson(input[index]!)}`;
    return `${output}]`;
  }
  const keys = Object.keys(input).sort();
  let output = "{";
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    output += `${index === 0 ? "" : ","}${JSON.stringify(key)}:${stableJson(input[key]!)}`;
  }
  return `${output}}`;
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
  const payload: JsonValue = {
    schema: 1,
    expectedTarget: {
      appInstanceId: expected.appInstanceId,
      activeGenerationId: expected.activeGenerationId,
      lineageEpoch: expected.lineageEpoch,
      protectionRevision: expected.protectionRevision,
      digestSchema: expected.digestSchema,
      stateSha256: expected.stateSha256,
    },
    request: fingerprintRequest,
  };
  return `sha256:${sha256HexSync(new TextEncoder().encode(stableJson(payload)))}`;
}

type AuthorityIdPrefix = "app" | "gen" | "ns" | "op" | "rel" | "req";

function encodeAuthorityId(prefix: AuthorityIdPrefix, bytes: Uint8Array): string {
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
  const id = `${prefix}_${encoded}`;
  if (encoded.length !== 26) throw unavailable("trusted identity source failed");
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

function operationIdForRequest(authorityIncarnationId: string, requestId: string): string {
  const digest = sha256HexSync(new TextEncoder().encode(
    `clay-production-operation-v1\u0000${authorityIncarnationId}\u0000${requestId}`,
  ));
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  return OperationId.parse(encodeAuthorityId("op", bytes));
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
const STORE_REMOVE_ATTACHMENT: ClayStore["removeAttachment"] = ClayStore.prototype.removeAttachment;
const STORE_PURGE_ATTACHMENTS: ClayStore["purgeDeletedAttachments"] =
  ClayStore.prototype.purgeDeletedAttachments;
const STORE_APPLY_BATCH: ClayStore["applyBatch"] = ClayStore.prototype.applyBatch;
const STORE_UNDO_BATCH: ClayStore["undoBatch"] = ClayStore.prototype.undoBatch;
const STORE_RESTORE_ROW: ClayStore["restoreRow"] = ClayStore.prototype.restoreRow;
const STORE_REGISTRY_SNAPSHOT: ClayStore["registrySnapshot"] = ClayStore.prototype.registrySnapshot;
const STORE_GET_SETTING: ClayStore["getSetting"] = ClayStore.prototype.getSetting;
const STORE_SET_SETTING: ClayStore["setSetting"] = ClayStore.prototype.setSetting;
const STORE_DELETE_SETTING: ClayStore["deleteSetting"] = ClayStore.prototype.deleteSetting;

function executeCapturedMutation(
  store: ClayStore,
  request: CapturedProductionMutation,
  executionInstant: string | null,
): JsonValue {
  switch (request.route) {
    case "store.insert":
      return captureJsonValue(STORE_INSERT.call(
        store,
        request.payload.table,
        request.payload.row as Record<string, unknown>,
      ), new WeakSet());
    case "store.update":
      return captureJsonValue(STORE_UPDATE.call(
        store,
        request.payload.table,
        request.payload.id,
        request.payload.patch as Record<string, unknown>,
      ), new WeakSet());
    case "store.softDelete":
      STORE_SOFT_DELETE.call(store, request.payload.table, request.payload.id);
      return null;
    case "store.commit":
      return STORE_COMMIT.call(
        store,
        request.payload.plan as unknown as Parameters<ClayStore["commit"]>[0],
      );
    case "starter.seed":
      if (executionInstant === null)
        throw invalid("trusted starter seed instant is unavailable");
      return executeCapturedStarterSeed(store, request.payload, executionInstant);
    case "attachment.add":
      return captureJsonValue(executeCapturedAttachmentAdd(store, {
        table: request.payload.table,
        rowId: request.payload.rowId,
        field: request.payload.field,
        name: request.payload.name,
        mime: request.payload.mime,
        bytes: new Uint8Array(request.payload.bytes.bytes),
      }, request.payload.bytes.sha256), new WeakSet());
    case "attachment.remove":
      STORE_REMOVE_ATTACHMENT.call(
        store,
        request.payload.table,
        request.payload.rowId,
        request.payload.field,
        request.payload.id,
      );
      return null;
    case "attachment.purge":
      if (executionInstant === null)
        throw invalid("trusted attachment purge instant is unavailable");
      return captureJsonValue(STORE_PURGE_ATTACHMENTS.call(
        store, new Date(executionInstant), 30,
      ), new WeakSet());
    case "batch.apply":
      return captureJsonValue(STORE_APPLY_BATCH.call(store, {
        source: request.payload.source,
        summary: request.payload.summary,
        mutations: request.payload.mutations as unknown as
          Parameters<ClayStore["applyBatch"]>[0]["mutations"],
      }), new WeakSet());
    case "batch.undo":
      return captureJsonValue(STORE_UNDO_BATCH.call(store, request.payload.id), new WeakSet());
    case "row.restore":
      return captureJsonValue(STORE_RESTORE_ROW.call(
        store, request.payload.table, request.payload.id,
      ), new WeakSet());
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
      return captureJsonValue(JSON.parse(registryJson) as unknown, new WeakSet());
    }
    case "setting.set":
      STORE_SET_SETTING.call(store, request.payload.key, request.payload.value);
      return null;
    case "setting.delete":
      STORE_DELETE_SETTING.call(store, request.payload.key);
      return null;
    case "setting.compareAndSet": {
      const current: unknown = STORE_GET_SETTING.call(store, request.payload.key);
      const revision = current && typeof current === "object"
        && Number.isSafeInteger((current as { revision?: unknown }).revision)
        ? Number((current as { revision: number }).revision) : 0;
      if (revision !== request.payload.expectedRevision)
        return captureJsonValue({ ok: false, current: current ?? null }, new WeakSet());
      STORE_SET_SETTING.call(store, request.payload.key, request.payload.value);
      return captureJsonValue({ ok: true, current: request.payload.value }, new WeakSet());
    }
    case "upsertAutomation":
    case "deleteAutomation":
    case "runAutomationNow":
    case "runDueAutomations":
    case "undoAutomationRun":
    case "markNotificationRead":
    case "recordUsage":
    case "acceptSuggestion":
    case "dismissSuggestion":
      return captureJsonValue(executeAutomationObserverAuthorityRoute(
        store, request.route, request.payload, executionInstant,
      ), new WeakSet());
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

const MAX_RESULT_BYTES = 2_000_000;

function canonicalResultValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(item => canonicalResultValue(item));
  if (value !== null && typeof value === "object") {
    const output: JsonRecord = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalResultValue(value[key]!);
    return output;
  }
  return value;
}

function encodeResult(result: JsonValue): { json: string; sha256: string } {
  const json = JSON.stringify(canonicalResultValue(result));
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_RESULT_BYTES)
    throw invalid("production mutation result exceeds the durable evidence limit");
  return { json, sha256: `sha256:${sha256HexSync(bytes)}` };
}

function decodeResult(json: string): JsonValue {
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw invalid("production mutation result JSON is invalid"); }
  return captureJsonValue(parsed, new WeakSet());
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

class SimulatedInvocationCrash extends Error {
  constructor() { super("simulated crash after durable invocation"); }
}

export type ProductionMutationTestFailure =
  | "live_mutation"
  | "after_live_mutation"
  | "stale_fence"
  | "abandonment_unavailable"
  | "crash_after_invocation";
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
    const run = this.#tail.then(() => this.#executeCaptured(captured));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  executeOperationalMetric(input: unknown): Promise<ProductionMutationResult> {
    if (this.#poisoned)
      return Promise.reject(invalid("production authority is poisoned; reopen for reservation recovery"));
    const captured = captureOperationalMetricMutation(input);
    const run = this.#tail.then(() => this.#executeOperationalCaptured(captured));
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

  async #executeCaptured(request: CapturedProductionMutation): Promise<ProductionMutationResult> {
    const outcome = this.#durableReceiptReplay(request);
    if (outcome) return outcome;
    const durable = this.#durableReplay(request);
    if (durable) return durable;
    this.#supersedeFenceForTest();
    this.#ensureWriteFence();
    const executionInstant = request.route === "starter.seed"
        || request.route === "attachment.purge"
        || request.route === "runAutomationNow"
        || request.route === "runDueAutomations"
      ? trustedInstant(this.#clock).instant : null;

    const expected = copyTarget(this.#target);
    const expectedCatalogGeneration = this.#catalogGeneration;
    const catalogBefore = DeviceCatalog.openExisting(this.#driver);
    if (catalogBefore.snapshot().catalogGeneration !== expectedCatalogGeneration
        || !sameTarget(catalogBefore.selectedTargetStorage().target, expected)
        || !sameTarget(TargetAuthorityStore.open(this.#driver).evidence(), expected))
      throw new ClayError("E_GENERATION_NOT_SELECTED", "production mutation target is stale");
    const liveBefore = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (liveBefore.stateSha256 !== expected.stateSha256)
      throw invalid("production mutation prestate is not canonical");

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
        throw invalid("production mutation snapshot is not canonical");
      const preparedResult = executeCapturedMutation(shadow, request, executionInstant);
      if (isThenable(preparedResult)) throw invalid("production mutation must be synchronous");
      shadowResult = copyResult(preparedResult);
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

    if (!shadowChanged)
      return this.#executeNoOp(
        request, expected, expectedCatalogGeneration, shadowResult,
      );
    return this.#executeMeaningful(
      request, expected, expectedCatalogGeneration, executionInstant,
    );
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
    const catalog = DeviceCatalog.openExisting(this.#driver);
    if (catalog.snapshot().catalogGeneration !== expectedCatalogGeneration
        || !sameTarget(catalog.selectedTargetStorage().target, expected)
        || !sameTarget(TargetAuthorityStore.open(this.#driver).evidence(), expected))
      throw new ClayError("E_GENERATION_NOT_SELECTED", "operational metric target is stale");
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
    const expected = copyTarget({
      appInstanceId: persisted.appInstanceId,
      activeGenerationId: persisted.activeGenerationId,
      lineageEpoch: persisted.lineageEpoch,
      protectionRevision: persisted.expectedProtectionRevision,
      digestSchema: this.#target.digestSchema,
      stateSha256: persisted.expectedStateSha256,
    });
    const fingerprint = requestFingerprint(expected, request);
    if (fingerprint !== persisted.requestSha256)
      throw invalid("production request identity was reused for another mutation");
    const expectedOperation = operationIdForRequest(
      this.#fence.authorityIncarnationId, request.requestId,
    );
    if (persisted.operationId !== expectedOperation)
      throw invalid("production request receipt operation identity is invalid");
    if (persisted.state === "prepared")
      throw invalid("prepared production request requires explicit recovery");
    if (persisted.state === "invoked")
      throw invalid("production request was already invoked and its result is ambiguous");
    if (persisted.resultingProtectionRevision === null
        || persisted.resultingStateSha256 === null || persisted.responseJson === null)
      throw invalid("terminal production request receipt is incomplete");
    const resulting = copyTarget({
      appInstanceId: persisted.appInstanceId,
      activeGenerationId: persisted.activeGenerationId,
      lineageEpoch: persisted.lineageEpoch,
      protectionRevision: persisted.resultingProtectionRevision,
      digestSchema: this.#target.digestSchema,
      stateSha256: persisted.resultingStateSha256,
    });
    const catalog = DeviceCatalog.openExisting(this.#driver);
    const current = TargetAuthorityStore.open(this.#driver).evidence();
    const canonical = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (!sameTarget(current, resulting))
      throw invalid("historical production request receipt is not independently auditable");
    if (!sameTarget(catalog.selectedTargetStorage().target, resulting)
        || !sameTarget(this.#target, resulting)
        || catalog.snapshot().catalogGeneration !== this.#catalogGeneration
        || canonical.stateSha256 !== resulting.stateSha256)
      throw invalid("production request receipt failed current-state read-back");
    if (request.route === "starter.seed"
        && (selectedCatalogShell(catalog, resulting) !== request.payload.shellId
          || STORE_GET_SETTING.call(this.#store, "shell_id") !== request.payload.shellId))
      throw invalid("production starter seed shell metadata failed replay read-back");
    const response = decodeResult(persisted.responseJson);
    if (persisted.state === "failed") {
      const message = response !== null && !Array.isArray(response)
        && typeof response === "object" && typeof response.message === "string"
        ? response.message : "production request failed previously";
      throw invalid(`production request failed previously: ${message}`);
    }
    return {
      requestId: request.requestId,
      operationId: persisted.operationId,
      changed: persisted.state === "committed",
      replayed: true,
      evidence: copyTarget(resulting),
      result: response,
    };
  }

  #durableReplay(request: CapturedProductionMutation): ProductionMutationResult | null {
    const operationId = operationIdForRequest(
      this.#fence.authorityIncarnationId, request.requestId,
    );
    const catalog = DeviceCatalog.openExisting(this.#driver);
    const target = TargetAuthorityStore.open(this.#driver);
    const targetRows = target.reservations()
      .filter(candidate => candidate.operationId === operationId);
    const catalogRows = catalog.revisionReservations()
      .filter(candidate => candidate.operationId === operationId);
    if (targetRows.length === 0 && catalogRows.length === 0) return null;
    if (targetRows.length !== 1 || catalogRows.length !== 1)
      throw invalid("production request has incomplete mirrored journal evidence");
    const targetRow = targetRows[0]!;
    const catalogRow = catalogRows[0]!;
    if (targetRow.revision !== catalogRow.revision
        || targetRow.requestSha256 !== catalogRow.requestSha256
        || targetRow.expectedProtectionRevision !== catalogRow.expectedProtectionRevision
        || targetRow.expectedStateSha256 !== catalogRow.expectedStateSha256)
      throw invalid("production request mirrored journal evidence disagrees");
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
      throw invalid("production request identity was reused for another mutation");
    if (targetRow.state !== catalogRow.state)
      throw invalid("production request mirrored journal states disagree");
    if (targetRow.state === "abandoned")
      throw invalid("production request was permanently abandoned");
    if (targetRow.state !== "committed")
      throw invalid("production request requires reservation recovery");
    if (!targetRow.stateSha256 || !catalogRow.stateSha256
        || !catalogRow.publishedActiveGenerationId || !catalogRow.publishedLineageEpoch)
      throw invalid("production request committed evidence is incomplete");
    const committed = copyTarget({
      appInstanceId: catalogRow.appInstanceId,
      activeGenerationId: catalogRow.publishedActiveGenerationId,
      lineageEpoch: catalogRow.publishedLineageEpoch,
      protectionRevision: targetRow.revision,
      digestSchema: this.#target.digestSchema,
      stateSha256: targetRow.stateSha256,
    });
    if (catalogRow.stateSha256 !== committed.stateSha256)
      throw invalid("production request committed target evidence disagrees");
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
    const operationId = operationIdForRequest(
      this.#fence.authorityIncarnationId, request.requestId,
    );
    const fingerprint = requestFingerprint(expected, request);
    const encoded = encodeResult(result);
    this.#writeAuthority.run(() => {
      const at = trustedInstant(this.#clock);
      const catalog = DeviceCatalog.openExisting(this.#driver);
      catalog.assertWriteFence(this.#fence, at.milliseconds);
      if (catalog.snapshot().catalogGeneration !== expectedCatalogGeneration
          || !sameTarget(catalog.selectedTargetStorage().target, expected)
          || !sameTarget(TargetAuthorityStore.open(this.#driver).evidence(), expected))
        throw new ClayError("E_GENERATION_NOT_SELECTED", "production no-op target is stale");
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
    return {
      requestId: request.requestId,
      operationId,
      changed: false,
      replayed: false,
      evidence: copyTarget(expected),
      result: copyResult(result),
    };
  }

  #assertFixedOperationalPrestate(
    expected: TargetEvidence,
    expectedCatalogGeneration: string,
    expectedOperationalFingerprint: string,
    nowMs: number,
  ): void {
    const catalog = DeviceCatalog.openExisting(this.#driver);
    catalog.assertWriteFence(this.#fence, nowMs);
    if (catalog.snapshot().catalogGeneration !== expectedCatalogGeneration
        || !sameTarget(catalog.selectedTargetStorage().target, expected)
        || !sameTarget(TargetAuthorityStore.open(this.#driver).evidence(), expected))
      throw new ClayError("E_GENERATION_NOT_SELECTED", "fixed operational mutation target is stale");
    const canonical = enumerateCanonicalStateV1(
      this.#driver, this.#store.validationRegistrySnapshot(),
    );
    if (canonical.stateSha256 !== expected.stateSha256)
      throw invalid("fixed operational mutation prestate is not canonical");
    if (privateMetricOperationalFingerprint(this.#driver) !== expectedOperationalFingerprint)
      throw invalid("fixed operational mutation prestate changed");
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
    return {
      requestId: request.requestId,
      operationId: operationIdForOperationalMetric(
        this.#fence.authorityIncarnationId, request.requestId,
      ),
      changed: false,
      replayed: false,
      evidence: copyTarget(expected),
      result: copyResult(result),
    };
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
      if (isThenable(result)) throw invalid("fixed operational mutation must be synchronous");
      if (TEST_FAILURE.get(this) === "after_live_mutation") {
        TEST_FAILURE.delete(this);
        throw invalid("injected failure after live mutation");
      }
      const canonical = enumerateCanonicalStateV1(
        this.#driver, this.#store.validationRegistrySnapshot(),
      );
      if (canonical.stateSha256 !== expected.stateSha256
          || !sameTarget(TargetAuthorityStore.open(this.#driver).evidence(), expected))
        throw invalid("fixed operational mutation reached canonical target state");
      const catalog = DeviceCatalog.openExisting(this.#driver);
      if (catalog.snapshot().catalogGeneration !== expectedCatalogGeneration
          || !sameTarget(catalog.selectedTargetStorage().target, expected))
        throw invalid("fixed operational mutation reached catalog authority");
      if (privateMetricOperationalFingerprint(this.#driver) === expectedOperationalFingerprint)
        throw invalid("fixed operational mutation became a no-op");
    });
    return {
      requestId: request.requestId,
      operationId: operationIdForOperationalMetric(
        this.#fence.authorityIncarnationId, request.requestId,
      ),
      changed: true,
      replayed: false,
      evidence: copyTarget(expected),
      result: copyResult(result),
    };
  }

  #executeMeaningful(
    request: CapturedProductionMutation,
    expected: TargetEvidence,
    expectedCatalogGeneration: string,
    executionInstant: string | null,
  ): ProductionMutationResult {
    const operationId = operationIdForRequest(
      this.#fence.authorityIncarnationId, request.requestId,
    );
    const fingerprint = requestFingerprint(expected, request);
    let reservedCatalogGeneration: string | null = null;
    let prepared: ProductionRequestReceipt | null = null;
    let result: JsonValue = null;
    try {
      const reservation = this.#writeAuthority.run(() => {
        const at = trustedInstant(this.#clock);
        const catalog = DeviceCatalog.openExisting(this.#driver);
        const target = TargetAuthorityStore.open(this.#driver);
        catalog.assertWriteFence(this.#fence, at.milliseconds);
        if (catalog.snapshot().catalogGeneration !== expectedCatalogGeneration
            || !sameTarget(catalog.selectedTargetStorage().target, expected)
            || !sameTarget(target.evidence(), expected))
          throw new ClayError("E_GENERATION_NOT_SELECTED", "production mutation target is stale");
        const canonical = enumerateCanonicalStateV1(
          this.#driver, this.#store.validationRegistrySnapshot(),
        );
        if (canonical.stateSha256 !== expected.stateSha256)
          throw invalid("production mutation prestate changed before reservation");
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
          throw invalid("production mutation reservation failed read-back");
        return {
          receipt,
          catalogGeneration: catalogReservation.reservedCatalogGeneration,
        };
      });
      prepared = reservation.receipt;
      reservedCatalogGeneration = reservation.catalogGeneration;

      const invoked = this.#writeAuthority.run(() => {
        const at = trustedInstant(this.#clock);
        const catalog = DeviceCatalog.openExisting(this.#driver);
        const target = TargetAuthorityStore.open(this.#driver);
        catalog.assertWriteFence(this.#fence, at.milliseconds);
        if (catalog.snapshot().catalogGeneration !== reservedCatalogGeneration
            || !sameTarget(catalog.selectedTargetStorage().target, expected)
            || !sameTarget(target.evidence(), expected))
          throw invalid("production mutation target changed before invocation");
        const targetReservation = target.reservations()
          .find(candidate => candidate.operationId === operationId);
        const catalogReservation = catalog.revisionReservations()
          .find(candidate => candidate.operationId === operationId);
        if (!targetReservation || !catalogReservation
            || targetReservation.state !== "reserved" || catalogReservation.state !== "reserved")
          throw invalid("production invocation reservation is unavailable");
        const persisted = readProductionRequestReceipt(this.#driver, request.requestId);
        if (!persisted || persisted.state !== "prepared")
          throw invalid("production request was not durably prepared");
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

      const committedState = this.#writeAuthority.run(() => {
        const at = trustedInstant(this.#clock);
        const catalog = DeviceCatalog.openExisting(this.#driver);
        const target = TargetAuthorityStore.open(this.#driver);
        catalog.assertWriteFence(this.#fence, at.milliseconds);
        if (catalog.snapshot().catalogGeneration !== reservedCatalogGeneration
            || !sameTarget(catalog.selectedTargetStorage().target, expected)
            || !sameTarget(target.evidence(), expected))
          throw new ClayError("E_GENERATION_NOT_SELECTED", "production mutation target is stale");
        const persistedReceipt = readProductionRequestReceipt(this.#driver, request.requestId);
        if (!persistedReceipt || persistedReceipt.state !== "invoked"
            || persistedReceipt.operationId !== operationId)
          throw invalid("production invocation marker is unavailable");
        const before = enumerateCanonicalStateV1(
          this.#driver, this.#store.validationRegistrySnapshot(),
        );
        if (before.stateSha256 !== expected.stateSha256)
          throw invalid("production mutation prestate changed before commit");
        result = executeCapturedMutation(this.#store, request, executionInstant);
        if (isThenable(result)) throw invalid("production mutation must be synchronous");
        if (TEST_FAILURE.get(this) === "after_live_mutation") {
          TEST_FAILURE.delete(this);
          throw invalid("injected failure after live mutation");
        }
        if (request.route === "starter.seed"
            && STORE_GET_SETTING.call(this.#store, "shell_id") !== request.payload.shellId)
          throw invalid("starter seed system shell metadata failed read-back");
        const publicationMetadata = request.route === "starter.seed" ? (() => {
          const app = catalog.snapshot().entries.find(candidate =>
            candidate.appInstanceId === expected.appInstanceId);
          if (!app) throw invalid("starter seed catalog app metadata is unavailable");
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
        const encodedResult = encodeResult(result);
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
          throw invalid("starter seed catalog shell metadata failed read-back");
        writeProductionRequestReceipt(
          this.#driver,
          terminalReceipt(
            invoked, "committed", committedTarget, encodedResult.sha256, at.instant,
          ),
          encodedResult.json,
          "invoked",
        );
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
          throw invalid("production mutation failed mirrored canonical read-back");
        return { target: committedTarget, catalogGeneration: finalCatalog.catalogGeneration };
      });

      const committed = committedState.target;
      this.#target = copyTarget(committed);
      this.#catalogGeneration = committedState.catalogGeneration;
      return {
        requestId: request.requestId,
        operationId,
        changed: true,
        replayed: false,
        evidence: copyTarget(committed),
        result: copyResult(result),
      };
    } catch (error) {
      if (error instanceof SimulatedInvocationCrash) throw error;
      if (reservedCatalogGeneration !== null && prepared !== null) {
        try {
          this.#recordAbandonment(
            operationId,
            request.requestId,
            fingerprint,
            expected,
            reservedCatalogGeneration,
            error,
          );
        } catch (abandonmentError) {
          this.#poisoned = true;
          throw abandonmentError;
        }
      }
      throw error;
    }
  }

  #recordAbandonment(
    operationId: string,
    requestId: string,
    fingerprint: string,
    expected: TargetEvidence,
    reservedCatalogGeneration: string,
    error: unknown,
  ): void {
    try {
      if (TEST_FAIL_ABANDONMENT.delete(this))
        throw invalid("production mutation failed and reservation recovery is required");
      const failure: JsonValue = {
        code: error instanceof ClayError ? error.code : "E_INTERNAL",
        message: error instanceof Error
          ? error.message.slice(0, 1_000) : "production mutation failed",
      };
      const encoded = encodeResult(failure);
      const at = trustedInstant(this.#clock);
      this.#writeAuthority.run(() => {
        const catalog = DeviceCatalog.openExisting(this.#driver);
        const target = TargetAuthorityStore.open(this.#driver);
        catalog.assertWriteFence(this.#fence, at.milliseconds);
        if (catalog.snapshot().catalogGeneration !== reservedCatalogGeneration
            || !sameTarget(catalog.selectedTargetStorage().target, expected)
            || !sameTarget(target.evidence(), expected))
          throw invalid("failed operation target changed before abandonment");
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
      throw invalid("production mutation failed and reservation recovery is required");
    }
  }
}