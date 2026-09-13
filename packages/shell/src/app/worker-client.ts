// Typed promise wrapper over the DB worker's command protocol.
import type {
  AttachmentFile, AttachmentMetadata, AttachmentStorageSummary,
  AutomationDefinition, AutomationDefinitionAny, AutomationDefinitionInput,
  AutomationDefinitionV2, AutomationDraftInputV2, AutomationExecutionResultV1,
  AutomationRecipeCardV1, AutomationRecipeDraftRequestV1, AutomationRun,
  AutomationRuntimeOverviewV1, AutomationRuntimeStatusV1,
  AutomationSimulationProofV1,
  BatchMutation, BatchReceipt, ClayNotification, CommitImportResult, DailyHomeSnapshot,
  DebugEvent, FieldProvenance,
  GlobalSearchResult,
  HistoryEntry, IntakeAcceptanceReceipt, IntakeAutoAcceptSimulation, IntakeDeliveryFailure,
  IntakeInboxItem, ImportReceipt, LivePanel, PanelProvenance,
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
import type {
  BackupPublicationReceipt,
  BackupPublicationRequest,
  BackupRecord,
  BackupRun,
  BackupStageValidation,
} from "@clay/kernel/backup";
import type { AuthenticatedFormat5RestoreGrant } from "@clay/kernel/recovery";
import type {
  ProductionBackupSelection,
} from "@clay/kernel/worker-authority";
import { ClayError } from "@clay/kernel/errors";
import { parseClosedBlueprintDirective } from "@clay/kernel/blueprint-contract";
import type {
  IntakeAutoAcceptDraftV1, IntakeAutoAcceptRuleV1,
  IntakeSubmissionPlaintextV1, LocalIntakeFormV1,
} from "@clay/schema/intake";
import { TargetEvidenceV1 } from "@clay/schema/catalog";
import type { IntentOutcome } from "../worker/db-worker";
import type { FirstSuccessState } from "./first-success-state";
import { fetchModelHealth } from "./model-health";
import type {
  ImportHeaderChoice, ImportParserChunk, ImportSourceDescriptor,
} from "@clay/kernel/import-staging-contracts";
import type {
  ConfigureImportInput,
  ImportCoordinatorPreview,
  ImportStructure,
} from "../worker/release-c/import-session-coordinator";
import type {
  BackupTrustRuntimeStatus,
  ImportedRecoveryKitStatus as RecoveryKitImportResult,
  RecoveryKitEnrollment,
} from "../worker/backup-trust-runtime";

export type TraceEntry = { at: string; intent: string; events: DebugEvent[] };

export type DurableMutationPromise<T> = Promise<T> & Readonly<{ requestId: string }>;

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

export type WorkerMutationContext = Readonly<{ requestId: string }>;

export type NewAppTableImport = Readonly<{
  table: string;
  columns: readonly Readonly<{
    name: string;
    type: "text" | "number" | "date" | "enum";
    values?: readonly string[];
  }>[];
  rows: readonly Readonly<Record<string, unknown>>[];
}>;

export type NewAppImportResult = Readonly<{
  appInstanceId: string;
  table: string;
  imported: number;
  columns: number;
  version: 1;
}>;

export type AuthorityCommitNotice = Readonly<{
  appInstanceId: string;
  activeGenerationId: string;
  lineageEpoch: string;
  protectionRevision: string;
  digestSchema: 1;
  stateSha256: string;
}>;

export type RecoveryRecordCandidate = Readonly<{
  table: string;
  id: string;
  deleted: boolean;
  historyAt: string;
  attachmentCount: number;
}>;

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

type ProjectionCancellationReceipt = Readonly<{
  targetId: number;
  quiescent: true;
  outcome: "cancelled" | "completed" | "failed" | "not_found";
}>;

function parseProjectionCancellationReceipt(
  value: unknown, targetId: number,
): ProjectionCancellationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Worker cancellation quiescence acknowledgement is missing.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 3 || raw.targetId !== targetId || raw.quiescent !== true
      || typeof raw.outcome !== "string"
      || !["cancelled", "completed", "failed", "not_found"].includes(raw.outcome))
    throw new Error("Worker cancellation quiescence acknowledgement is invalid.");
  return raw as ProjectionCancellationReceipt;
}

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

function captureWorkerMutationContext(value: WorkerMutationContext): WorkerMutationContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null))
    throw new TypeError("worker mutation request identity is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 1)
    throw new TypeError("worker mutation request identity is invalid");
  const descriptor = descriptors.requestId;
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== "string"
      || !/^req_[a-z2-7]{26}$/.test(descriptor.value))
    throw new TypeError("worker mutation request identity is invalid");
  return Object.freeze({ requestId: descriptor.value });
}

export function createWorkerMutationContext(): WorkerMutationContext {
  return Object.freeze({ requestId: mintWorkerRequestId() });
}

export type ModelAccess = {
  provider: "clay" | "openai" | "anthropic" | "codex";
  apiKey: string | null;
  backendUrl: string | null;
  session: string | null;
  providerToken?: string | null;
  allowAmbientCredentials?: boolean;
  protectedSecrets?: readonly string[];
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
    ...required, "providerToken", "allowAmbientCredentials", "protectedSecrets",
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
  const protectedDescriptor = descriptors.protectedSecrets;
  const rawProtectedSecrets = protectedDescriptor ? field("protectedSecrets") : [];
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
  if (!Array.isArray(rawProtectedSecrets) || rawProtectedSecrets.length > 32)
    throw new Error("invalid model access");
  const secretDescriptors = Object.getOwnPropertyDescriptors(rawProtectedSecrets);
  const arrayKeys = Reflect.ownKeys(secretDescriptors);
  if (arrayKeys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key))))
    throw new Error("invalid model access");
  const protectedSecrets: string[] = [];
  for (let index = 0; index < rawProtectedSecrets.length; index++) {
    const descriptor = secretDescriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
        || !validSecret(descriptor.value) || descriptor.value === null
        || descriptor.value === undefined) throw new Error("invalid model access");
    protectedSecrets.push(descriptor.value);
  }
  for (const secret of [apiKey, session, providerToken])
    if (typeof secret === "string") protectedSecrets.push(secret);
  return Object.freeze({
    provider: provider as ModelAccess["provider"],
    apiKey: provider === "anthropic" ? apiKey as string | null : null,
    backendUrl: provider === "anthropic" ? null : backendUrl as string | null,
    session: provider === "clay" ? session as string | null : null,
    allowAmbientCredentials: provider === "clay" && allowAmbientCredentials,
    ...(provider === "codex" ? { providerToken: providerToken ?? null } : {}),
    protectedSecrets: Object.freeze([...new Set(protectedSecrets)]),
  });
}

type PlannerBinding = {
  epoch: string; generation: number; contextId: string;
  attempt: 0 | 1; sequence: number;
};

const ESCAPE_SCAN_WORK_LIMIT = 16 * 1024 * 1024;

function decodeJavaScriptEscapes(input: string): string {
  let output = "";
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character !== "\\" || index + 1 >= input.length) {
      output += character;
      continue;
    }
    const code = input[++index]!;
    if (code === "x" && /^[0-9a-f]{2}$/i.test(input.slice(index + 1, index + 3))) {
      output += String.fromCharCode(Number.parseInt(input.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    if (code === "u" && input[index + 1] === "{") {
      const close = input.indexOf("}", index + 2);
      const hex = close >= 0 ? input.slice(index + 2, close) : "";
      if (/^[0-9a-f]{1,6}$/i.test(hex)) {
        const point = Number.parseInt(hex, 16);
        if (point <= 0x10ffff) {
          output += String.fromCodePoint(point);
          index = close;
          continue;
        }
      }
    }
    if (code === "u" && /^[0-9a-f]{4}$/i.test(input.slice(index + 1, index + 5))) {
      output += String.fromCharCode(Number.parseInt(input.slice(index + 1, index + 5), 16));
      index += 4;
      continue;
    }
    const simple: Record<string, string> = {
      "\\": "\\", "\"": "\"", "'": "'", "/": "/",
      b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0",
    };
    if (Object.hasOwn(simple, code)) output += simple[code];
    else if (code === "\n") { /* escaped line continuation */ }
    else if (code === "\r") {
      if (input[index + 1] === "\n") index++;
    } else output += code;
  }
  return output;
}

type StaticLiteral = { start: number; end: number; value: string };

function skipStaticTrivia(source: string, start: number): number {
  let index = start;
  for (;;) {
    while (index < source.length && /\s/.test(source[index]!)) index++;
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    return index;
  }
}

const STATIC_EXPRESSION_DEPTH_LIMIT = 64;
const STATIC_EXPRESSION_STEP_LIMIT = 100_000;
const STATIC_EXPRESSION_VALUE_LIMIT = 8_192;

type StaticStringExpression = { end: number; value: string };
type StaticExpressionState = {
  source: string;
  literalAt: Map<number, StaticLiteral>;
  steps: number;
  overflow: boolean;
};

function spendStaticStep(state: StaticExpressionState, amount = 1): boolean {
  state.steps += amount;
  if (state.steps <= STATIC_EXPRESSION_STEP_LIMIT) return true;
  state.overflow = true;
  return false;
}

function combineStaticStrings(
  state: StaticExpressionState, left: string, right: string,
): string | null {
  if (left.length + right.length > ESCAPE_SCAN_WORK_LIMIT) {
    state.overflow = true;
    return null;
  }
  return left + right;
}

function parseStaticStringExpression(
  state: StaticExpressionState, start: number, depth = 0,
): StaticStringExpression | null {
  if (depth > STATIC_EXPRESSION_DEPTH_LIMIT || !spendStaticStep(state)) {
    state.overflow = true;
    return null;
  }
  let current = parseStaticStringPrimary(state, start, depth + 1);
  if (!current) return null;
  for (;;) {
    const operator = skipStaticTrivia(state.source, current.end);
    if (state.source[operator] !== "+") break;
    const right = parseStaticStringPrimary(state, operator + 1, depth + 1);
    if (!right) break;
    const value = combineStaticStrings(state, current.value, right.value);
    if (value === null) return null;
    current = { end: right.end, value };
  }
  return current;
}

function parseStaticTemplate(
  state: StaticExpressionState, start: number, depth: number,
): StaticStringExpression | null {
  const { source } = state;
  if (source[start] !== "`") return null;
  let cursor = start + 1;
  let raw = "";
  let value = "";
  while (cursor < source.length) {
    if (!spendStaticStep(state)) return null;
    const character = source[cursor]!;
    if (character === "\\" && cursor + 1 < source.length) {
      raw += character + source[cursor + 1]!;
      cursor += 2;
      continue;
    }
    if (character === "`") {
      const tail = decodeJavaScriptEscapes(raw);
      const complete = combineStaticStrings(state, value, tail);
      return complete === null ? null : { end: cursor + 1, value: complete };
    }
    if (character === "$" && source[cursor + 1] === "{") {
      const quasi = decodeJavaScriptEscapes(raw);
      const withQuasi = combineStaticStrings(state, value, quasi);
      if (withQuasi === null) return null;
      const expression = parseStaticStringExpression(state, cursor + 2, depth + 1);
      if (!expression) return null;
      const close = skipStaticTrivia(source, expression.end);
      if (source[close] !== "}") return null;
      const combined = combineStaticStrings(state, withQuasi, expression.value);
      if (combined === null) return null;
      value = combined;
      raw = "";
      cursor = close + 1;
      continue;
    }
    raw += character;
    if (raw.length + value.length > ESCAPE_SCAN_WORK_LIMIT) {
      state.overflow = true;
      return null;
    }
    cursor++;
  }
  return null;
}

function parseStaticArrayJoin(
  state: StaticExpressionState, start: number, depth: number,
): StaticStringExpression | null {
  const { source, literalAt } = state;
  if (source[start] !== "[") return null;
  let cursor = skipStaticTrivia(source, start + 1);
  const values: string[] = [];
  if (source[cursor] !== "]") {
    for (;;) {
      if (values.length >= STATIC_EXPRESSION_VALUE_LIMIT) {
        state.overflow = true;
        return null;
      }
      const item = parseStaticStringExpression(state, cursor, depth + 1);
      if (!item) return null;
      values.push(item.value);
      cursor = skipStaticTrivia(source, item.end);
      if (source[cursor] !== ",") break;
      cursor = skipStaticTrivia(source, cursor + 1);
      if (source[cursor] === "]") break;
    }
  }
  if (source[cursor] !== "]") return null;
  cursor = skipStaticTrivia(source, cursor + 1);
  if (source[cursor] === ".") {
    cursor = skipStaticTrivia(source, cursor + 1);
    if (!source.startsWith("join", cursor) || /[A-Za-z0-9_$]/.test(source[cursor + 4] ?? ""))
      return null;
    cursor += 4;
  } else if (source[cursor] === "[") {
    cursor = skipStaticTrivia(source, cursor + 1);
    const member = literalAt.get(cursor);
    if (!member || member.value !== "join") return null;
    cursor = skipStaticTrivia(source, member.end);
    if (source[cursor] !== "]") return null;
    cursor = skipStaticTrivia(source, cursor + 1);
  } else return null;
  if (source[cursor] !== "(") return null;
  cursor = skipStaticTrivia(source, cursor + 1);
  let separator = ",";
  if (source[cursor] !== ")") {
    const parsed = parseStaticStringExpression(state, cursor, depth + 1);
    if (!parsed) return null;
    separator = parsed.value;
    cursor = skipStaticTrivia(source, parsed.end);
  }
  if (source[cursor] !== ")") return null;
  const value = values.join(separator);
  if (value.length > ESCAPE_SCAN_WORK_LIMIT) {
    state.overflow = true;
    return null;
  }
  return { end: cursor + 1, value };
}

function parseStaticStringPrimary(
  state: StaticExpressionState, start: number, depth: number,
): StaticStringExpression | null {
  if (depth > STATIC_EXPRESSION_DEPTH_LIMIT || !spendStaticStep(state)) {
    state.overflow = true;
    return null;
  }
  const index = skipStaticTrivia(state.source, start);
  const literal = state.literalAt.get(index);
  if (literal) return { end: literal.end, value: literal.value };
  if (state.source[index] === "(") {
    const inner = parseStaticStringExpression(state, index + 1, depth + 1);
    if (!inner) return null;
    const close = skipStaticTrivia(state.source, inner.end);
    return state.source[close] === ")" ? { end: close + 1, value: inner.value } : null;
  }
  if (state.source[index] === "`") return parseStaticTemplate(state, index, depth + 1);
  if (state.source[index] === "[") return parseStaticArrayJoin(state, index, depth + 1);
  return null;
}

function extractStaticJavaScriptStrings(source: string): string[] | null {
  const literals: StaticLiteral[] = [];
  for (let index = 0; index < source.length; index++) {
    const quote = source[index];
    if (quote !== "\"" && quote !== "'" && quote !== "`") continue;
    const start = index;
    let raw = "";
    let complete = false;
    let dynamic = false;
    for (index++; index < source.length; index++) {
      const character = source[index]!;
      if (character === "\\" && index + 1 < source.length) {
        raw += character + source[++index]!;
        continue;
      }
      if (quote === "`" && character === "$" && source[index + 1] === "{") {
        dynamic = true;
        break;
      }
      if (character === quote) { complete = true; break; }
      if (quote !== "`" && (character === "\n" || character === "\r")) break;
      raw += character;
    }
    if (complete && !dynamic) literals.push({
      start, end: index + 1, value: decodeJavaScriptEscapes(raw),
    });
  }
  const values = literals.map(literal => literal.value);
  let lexicalJoin = "";
  for (const literal of literals) {
    if (lexicalJoin.length + literal.value.length > ESCAPE_SCAN_WORK_LIMIT) return null;
    lexicalJoin += literal.value;
  }
  if (literals.length > 1) values.push(lexicalJoin);
  const literalAt = new Map(literals.map(literal => [literal.start, literal]));
  const state: StaticExpressionState = {
    source, literalAt, steps: 0, overflow: false,
  };
  let attempts = 0;
  for (let start = 0; start < source.length; start++) {
    const character = source[start];
    if (character !== "\"" && character !== "'" && character !== "`"
        && character !== "(" && character !== "[") continue;
    if (++attempts > STATIC_EXPRESSION_VALUE_LIMIT) {
      state.overflow = true;
      break;
    }
    const expression = parseStaticStringExpression(state, start);
    if (expression && !values.includes(expression.value)) values.push(expression.value);
    if (state.overflow) break;
  }
  if (state.overflow) return null;
  const derivedAtoms = literals.map(literal => ({
    start: literal.start,
    value: literal.value,
  }));
  const characterCodeStarts = [...source.matchAll(
    /String\s*\.\s*from(?:CharCode|CodePoint)\s*\(/gi,
  )].length;
  let characterCodeMatches = 0;
  for (const match of source.matchAll(
    /String\s*\.\s*from(CharCode|CodePoint)\s*\(\s*(?:\.\.\.\s*\[\s*)?([\s\d,a-fx+\-.eE]+?)(?:\]\s*)?\)/gi,
  )) {
    characterCodeMatches++;
    const rawValues = match[2]!.split(",").map(value => value.trim());
    const numericLiteral = /^[+-]?(?:0x[0-9a-f]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?)$/i;
    if (rawValues.length < 1 || rawValues.length > 8_192
        || rawValues.some(value => !numericLiteral.test(value))) return null;
    const numbers = rawValues.map(value => Number(value));
    if (numbers.some(value => !Number.isFinite(value))) return null;
    const charCode = match[1]!.toLowerCase() === "charcode";
    const points = charCode
      ? numbers.map(value => ((Math.trunc(value) % 0x10000) + 0x10000) % 0x10000)
      : numbers;
    if (!charCode && points.some(point =>
      !Number.isSafeInteger(point) || point < 0 || point > 0x10ffff)) return null;
    try {
      const value = match[1]!.toLowerCase() === "charcode"
        ? String.fromCharCode(...points) : String.fromCodePoint(...points);
      values.push(value);
      const reversed = [...value].reverse().join("");
      if (reversed !== value) values.push(reversed);
      derivedAtoms.push({ start: match.index!, value });
    } catch { /* malformed code point */ }
  }
  if (characterCodeMatches !== characterCodeStarts) return null;
  if (derivedAtoms.length > 1) {
    derivedAtoms.sort((left, right) => left.start - right.start);
    let combined = "";
    for (const atom of derivedAtoms) {
      if (combined.length + atom.value.length > ESCAPE_SCAN_WORK_LIMIT) return null;
      combined += atom.value;
    }
    values.push(combined);
  }
  return values;
}

function utf8Base64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fullyPercentEncode(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
}

function decodeBase64(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[a-z0-9+/]+={0,2}$/i.test(normalized) || normalized.length % 4 === 1) return null;
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
}

function containsProtectedSecret(text: string, secretsInput: Iterable<string>): boolean {
  const secrets = [...new Set(secretsInput)].filter(secret => secret.length > 0);
  if (secrets.length === 0) return false;
  const encoded = new Set<string>();
  for (const secret of secrets) {
    const bytes = new TextEncoder().encode(secret);
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const base64 = utf8Base64(secret);
    for (const value of [
      secret, hex, hex.toUpperCase(), base64, base64.replace(/=+$/, ""),
      base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      fullyPercentEncode(secret), fullyPercentEncode(secret).toUpperCase(),
    ]) if (value) encoded.add(value);
  }

  const queue: string[] = [];
  const seen = new Set<string>();
  let queuedWork = 0;
  let overflow = false;
  const enqueue = (candidate: string): void => {
    if (!candidate || seen.has(candidate)) return;
    queuedWork += candidate.length;
    if (queuedWork > ESCAPE_SCAN_WORK_LIMIT) { overflow = true; return; }
    seen.add(candidate);
    queue.push(candidate);
  };
  enqueue(text);
  while (queue.length > 0) {
    if (overflow) return true;
    const candidate = queue.shift()!;
    if ([...encoded].some(form => candidate.includes(form))) return true;

    const escaped = decodeJavaScriptEscapes(candidate);
    if (escaped !== candidate) enqueue(escaped);
    try {
      const percent = decodeURIComponent(candidate);
      if (percent !== candidate) enqueue(percent);
    } catch { /* malformed percent data */ }
    for (const match of candidate.matchAll(/(?:%[0-9a-f]{2}){4,}/gi)) {
      try { enqueue(decodeURIComponent(match[0])); } catch { /* malformed UTF-8 */ }
    }
    for (const match of candidate.matchAll(/\b(?:[0-9a-f]{2}){4,}\b/gi)) {
      const bytes = new Uint8Array(match[0].length / 2);
      for (let index = 0; index < bytes.length; index++)
        bytes[index] = Number.parseInt(match[0].slice(index * 2, index * 2 + 2), 16);
      try { enqueue(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { /* not UTF-8 text */ }
    }
    for (const match of candidate.matchAll(/\b[a-z0-9+/_-]{12,}={0,2}\b/gi)) {
      const decoded = decodeBase64(match[0]);
      if (decoded !== null) enqueue(decoded);
    }
    const staticStrings = extractStaticJavaScriptStrings(candidate);
    if (staticStrings === null) return true;
    for (const value of staticStrings) enqueue(value);

    try {
      const parsed = JSON.parse(candidate) as unknown;
      const values: unknown[] = [parsed];
      let nodes = 0;
      while (values.length > 0 && nodes++ < 100_000) {
        const value = values.pop();
        if (typeof value === "string") enqueue(value);
        else if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) values.push(value[index]);
        } else if (value && typeof value === "object") {
          for (const child of Object.values(value as Record<string, unknown>)) values.push(child);
        }
      }
      if (values.length > 0) return true;
    } catch { /* candidate is not standalone JSON */ }
  }
  return overflow;
}

function isDeclarativeBlueprint(code: string): boolean {
  try { return parseClosedBlueprintDirective(code) !== null; }
  catch { return false; }
}

function existingPlannerPanelCodes(panels: readonly unknown[]): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const panel of panels) {
    if (!panel || typeof panel !== "object" || Array.isArray(panel)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(panel, "code");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string")
      codes.add(descriptor.value);
  }
  return codes;
}

function plannerOutputIsConfined(
  raw: string,
  secretsInput: Iterable<string>,
  existingCodes: ReadonlySet<string>,
): boolean {
  const secrets = [...secretsInput].filter(secret => secret.length > 0);
  if (containsProtectedSecret(raw, secrets)) return false;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const panelsDescriptor = Reflect.getOwnPropertyDescriptor(value, "panels");
  if (!panelsDescriptor || !("value" in panelsDescriptor)
      || !Array.isArray(panelsDescriptor.value)) return false;
  for (const panel of panelsDescriptor.value) {
    if (!panel || typeof panel !== "object" || Array.isArray(panel)) return false;
    const codeDescriptor = Reflect.getOwnPropertyDescriptor(panel, "code");
    if (!codeDescriptor || !("value" in codeDescriptor)
        || typeof codeDescriptor.value !== "string") return false;
    if (!existingCodes.has(codeDescriptor.value)
        && !isDeclarativeBlueprint(codeDescriptor.value)) return false;
  }
  return true;
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

// A transport has exactly one response owner. Retain its sequence across client
// replacement so a late old response cannot satisfy a new client's request.
const workerTransports = new WeakMap<Worker, { owner: WorkerClient; nextId: number }>();

export class WorkerClient {
  #modelAccess: Readonly<ModelAccess> = Object.freeze({
    provider: "clay", apiKey: null, backendUrl: null, session: null,
    allowAmbientCredentials: false, protectedSecrets: Object.freeze([]),
  });
  #protectedSecrets = new Set<string>();
  #terminated = false;
  #accepting = true;
  #lifecycle = 0;
  #modelAccessPreparationGeneration = 0;
  #modelAccessGeneration = 0;
  #shutdownPromise: Promise<void> | null = null;
  #activePlanners = new Set<ActivePlanner>();
  #authorityCommitListeners = new Set<(notice: AuthorityCommitNotice) => void>();
  readonly #transport: { owner: WorkerClient; nextId: number };
  private readonly pending = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void;
  }>();

  constructor(private readonly worker: Worker) {
    const previous = workerTransports.get(worker);
    previous?.owner.closeClient(new ClayError("E_INTERNAL",
      "Worker connection was replaced; durable outcome is unknown. Retry the same request to reconcile it."));
    this.#transport = previous ?? { owner: this, nextId: 1 };
    this.#transport.owner = this;
    workerTransports.set(worker, this.#transport);
    worker.onmessage = (ev): void => {
      const event = ev.data as { event?: unknown; target?: unknown };
      if (event?.event === "authority_commit") {
        const parsed = TargetEvidenceV1.safeParse(event.target);
        if (parsed.success) {
          const notice = Object.freeze({ ...parsed.data });
          for (const listener of this.#authorityCommitListeners) listener(notice);
        }
        return;
      }
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

  private beginCall<T>(
    requestId: string,
    op: string,
    payload?: Record<string, unknown>,
    transfer?: Transferable[],
  ): { id: number; promise: Promise<T> } {
    if (this.#terminated) {
      return {
        id: -1,
        promise: Promise.reject(new Error("DB worker was terminated")),
      };
    }
    if (!this.#accepting && op !== "shutdown") {
      return {
        id: -1,
        promise: Promise.reject(new Error("DB worker shutdown is in progress")),
      };
    }
    if (typeof requestId !== "string" || !/^req_[a-z2-7]{26}$/.test(requestId)) {
      return {
        id: -1,
        promise: Promise.reject(new TypeError("worker request identity is invalid")),
      };
    }
    const id = this.#transport.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        cleanup: () => undefined,
      });
      try {
        this.worker.postMessage({ id, requestId, op, payload }, transfer ?? []);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { id, promise };
  }

  private call<T>(
    requestId: string,
    op: string,
    payload?: Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<T>;
  private call<T>(
    op: string,
    payload?: Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<T>;
  private call<T>(
    requestIdOrOp: string,
    opOrPayload?: string | Record<string, unknown>,
    payloadOrTransfer?: Record<string, unknown> | Transferable[],
    transfer?: Transferable[],
  ): Promise<T> {
    if (typeof opOrPayload === "string") {
      return this.beginCall<T>(
        requestIdOrOp, opOrPayload, payloadOrTransfer as Record<string, unknown> | undefined, transfer,
      ).promise;
    }
    return this.beginCall<T>(
      mintWorkerRequestId(),
      requestIdOrOp,
      opOrPayload,
      payloadOrTransfer as Transferable[] | undefined,
    ).promise;
  }

  private callProjection(
    request: ProjectionRequestV1, signal?: AbortSignal,
  ): Promise<ProjectionTransportV1> {
    if (signal?.aborted)
      return Promise.reject(new ClayError("E_CANCELLED", "The local export projection was cancelled."));
    const target = this.beginCall<ProjectionTransportV1>(
      mintWorkerRequestId(), "projectPlaintextV1", request,
    );
    if (!signal) return target.promise;
    return new Promise<ProjectionTransportV1>((resolve, reject) => {
      let cancelling = false;
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      const abort = (): void => {
        if (cancelling) return;
        cancelling = true;
        cleanup();
        const acknowledgement = this.ephemeralCall<unknown>(
          "cancelProjectionV1", { targetId: target.id },
        );
        void Promise.allSettled([target.promise, acknowledgement]).then(results => {
          const [terminal, acknowledged] = results;
          if (acknowledged.status === "rejected") {
            reject(new Error(`Worker cancellation quiescence acknowledgement failed: ${
              acknowledged.reason instanceof Error
                ? acknowledged.reason.message : String(acknowledged.reason)}`));
            return;
          }
          let receipt: ProjectionCancellationReceipt;
          try {
            receipt = parseProjectionCancellationReceipt(acknowledged.value, target.id);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (terminal.status === "fulfilled") {
            reject(new Error("Worker emitted a late artifact instead of honoring cancellation quiescence."));
            return;
          }
          if (terminal.reason instanceof ClayError && terminal.reason.code === "E_CANCELLED") {
            if (receipt.outcome !== "cancelled") {
              reject(new Error(
                "Worker cancellation terminal and quiescence outcome disagree.",
              ));
              return;
            }
            reject(new ClayError(
              "E_CANCELLED", terminal.reason.message,
              { targetId: receipt.targetId, quiescent: true, outcome: receipt.outcome },
            ));
            return;
          }
          reject(terminal.reason instanceof Error ? terminal.reason
            : new Error("Worker projection failed while cancellation was pending."));
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      void target.promise.then(value => {
        if (cancelling) return;
        cleanup();
        resolve(value);
      }, error => {
        if (cancelling) return;
        cleanup();
        reject(error);
      });
      if (signal.aborted) abort();
    });
  }

  private ephemeralCall<T>(
    op: string,
    payload?: Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<T> {
    return this.call(mintWorkerRequestId(), op, payload, transfer);
  }

  private mutationCall<T>(
    op: string,
    payload: Record<string, unknown> | undefined,
    context: WorkerMutationContext,
    transfer?: Transferable[],
  ): DurableMutationPromise<T> {
    let captured: WorkerMutationContext;
    try {
      captured = captureWorkerMutationContext(context);
    } catch (error) {
      return Promise.reject(error) as DurableMutationPromise<T>;
    }
    const completion = this.call<T>(
      captured.requestId, op, payload, transfer,
    ) as DurableMutationPromise<T>;
    Object.defineProperty(completion, "requestId", {
      value: captured.requestId, enumerable: true, configurable: false, writable: false,
    });
    return completion;
  }

  private lifecycleCall(
    op: "createApp" | "forkApp" | "switchApp" | "renameApp" | "deleteApp",
    payload: Record<string, unknown>,
    context: WorkerMutationContext,
  ): DurableMutationPromise<BootInfo> {
    const request = this.mutationCall<unknown>(op, payload, context);
    const completion = request.then(parseBootInfo) as DurableMutationPromise<BootInfo>;
    Object.defineProperty(completion, "requestId", {
      value: request.requestId, enumerable: true, configurable: false, writable: false,
    });
    return completion;
  }

  /** Mint once at the user-operation boundary and pass the same context to a
   * reconstructed WorkerClient when an authenticated response was lost. */
  createMutationContext(): WorkerMutationContext {
    return createWorkerMutationContext();
  }

  onAuthorityCommit(listener: (notice: AuthorityCommitNotice) => void): () => void {
    this.#authorityCommitListeners.add(listener);
    return () => { this.#authorityCommitListeners.delete(listener); };
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
      const shutdownRequest = createWorkerMutationContext();
      const acknowledged = await settlesWithin(
        this.call(shutdownRequest.requestId, "shutdown"), timeoutMs,
      );
      this.terminate();
      if (!acknowledged) throw new Error("worker did not acknowledge quiescent shutdown");
    })();
    return this.#shutdownPromise;
  }

  terminate(): void {
    if (this.#terminated) return;
    this.closeClient(new Error("DB worker was terminated"));
    try { this.worker.terminate(); } catch { /* already gone */ }
  }

  private closeClient(error: Error): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#accepting = false;
    this.#lifecycle++;
    this.#modelAccessPreparationGeneration++;
    this.#modelAccessGeneration++;
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.pending.clear();
    this.#authorityCommitListeners.clear();
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
  }

  async boot(request: BootRequest): Promise<BootInfo> {
    const captured = parseBootRequest(request);
    const context = createWorkerMutationContext();
    return parseBootInfo(await this.call<unknown>(
      context.requestId, "boot", captured,
    ));
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
      protectedSecrets: current.protectedSecrets,
    });
    this.#publishModelAccess(access, generation);
  }

  #publishModelAccess(access: Readonly<ModelAccess>, generation: number): void {
    for (const secret of access.protectedSecrets ?? []) this.#protectedSecrets.add(secret);
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

  #redactPlannerError(error: unknown): {
    code: "E_NET" | "E_MODEL"; message: string;
  } {
    const descriptors = typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptors(error) : {};
    const codeValue = descriptors.code && "value" in descriptors.code
      ? descriptors.code.value : undefined;
    const messageValue = descriptors.message && "value" in descriptors.message
      ? descriptors.message.value : undefined;
    const code = codeValue === "E_MODEL" ? "E_MODEL" : "E_NET";
    let message = typeof messageValue === "string"
      ? messageValue : "model request failed without transferable diagnostic";
    if (containsProtectedSecret(message, this.#protectedSecrets)) {
      message = "model request failed without transferable diagnostic";
    } else {
      for (const secret of this.#protectedSecrets)
        message = message.replaceAll(secret, "[redacted]");
    }
    return { code, message: message.slice(0, 512) };
  }

  #servePlanner(active: ActivePlanner, access: Readonly<ModelAccess>, lifecycle: number): void {
    let initial: { epoch: string; generation: number; contextId: string; contextJson: string } | null = null;
    let client: Pick<
      import("@clay/mutation/client").MutationClient, "rawPlan" | "rawRepair"
    > | null = null;
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
      }), this.#protectedSecrets)) {
        failClosed(binding);
        return;
      }
      const existingPanelCodes = existingPlannerPanelCodes(message.context.panels);
      busy = true;
      expectedSequence++;
      void (async () => {
        try {
          if (!access.apiKey && !access.backendUrl) throw Object.assign(
            new Error("No model connection. Add an API key or connect a backend in Settings."),
            { code: "E_MODEL" },
          );
          let requestClient = client;
          if (!requestClient) {
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
            requestClient = new MutationClient(transport, {
              modelRepair: true, signal: active.controller.signal,
            });
            client = requestClient;
          }
          const context = message.context as never;
          const raw = binding.attempt === 0
            ? await requestClient.rawPlan(context)
            : await requestClient.rawRepair(
              context,
              (message.repair as { priorRaw: string }).priorRaw,
              (message.repair as { diagnostics: string[] }).diagnostics,
            );
          if (active.closed || this.#terminated || lifecycle !== this.#lifecycle) return;
          if (raw.length > 64 * 1024) throw Object.assign(
            new Error("model output exceeds the planner bridge limit"), { code: "E_MODEL" },
          );
          if (!plannerOutputIsConfined(
            raw, this.#protectedSecrets, existingPanelCodes,
          )) throw Object.assign(
            new Error("model response was not confined to declarative panel code"),
            { code: "E_MODEL" },
          );
          active.port.postMessage({
            v: 1, kind: "planner.response", ...binding,
            result: { ok: true, raw },
          });
        } catch (error) {
          if (active.closed || this.#terminated || lifecycle !== this.#lifecycle) return;
          active.port.postMessage({
            v: 1, kind: "planner.response", ...binding,
            result: { ok: false, error: this.#redactPlannerError(error) },
          });
        } finally {
          busy = false;
        }
      })();
    };
    active.port.onmessageerror = () => failClosed(active.binding);
    active.port.start();
  }

  async #plannerCall(
    op: "intent" | "repairPanel",
    payload: Record<string, unknown>,
    context: WorkerMutationContext,
  ): Promise<IntentOutcome> {
    if (this.#terminated) throw new Error("DB worker was terminated");
    if (!this.#accepting) throw new Error("DB worker shutdown is in progress");
    if (this.#modelAccessPreparationGeneration !== this.#modelAccessGeneration)
      throw new Error("model access update is in progress");
    const logicalRequest = captureWorkerMutationContext(context);
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
      const outcome = await this.call<IntentOutcome>(
        logicalRequest.requestId, op, payload, [channel.port2],
      );
      if (active.closed || this.#terminated || lifecycle !== this.#lifecycle
          || active.accessGeneration !== this.#modelAccessGeneration) {
        if (outcome?.status === "preview") {
          try {
            const discard = createWorkerMutationContext();
            await this.call<null>(discard.requestId, "discard");
          }
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

  createApp(
    displayName: string, shellId: string, context: WorkerMutationContext,
  ): DurableMutationPromise<BootInfo> {
    return this.lifecycleCall("createApp", { displayName, shellId }, context);
  }
  switchApp(
    appInstanceId: string, context: WorkerMutationContext,
  ): DurableMutationPromise<BootInfo> {
    return this.lifecycleCall("switchApp", { appInstanceId }, context);
  }
  renameApp(
    appInstanceId: string,
    displayName: string,
    context: WorkerMutationContext,
    shellId: string | null = null,
  ): DurableMutationPromise<BootInfo> {
    return this.lifecycleCall(
      "renameApp", { appInstanceId, displayName, shellId }, context,
    );
  }
  forkApp(context: WorkerMutationContext): DurableMutationPromise<BootInfo> {
    return this.lifecycleCall("forkApp", {}, context);
  }
  deleteApp(
    appInstanceId: string, context: WorkerMutationContext,
  ): DurableMutationPromise<BootInfo> {
    return this.lifecycleCall("deleteApp", { appInstanceId }, context);
  }
  importNewApp(
    binding: string | TargetEvidenceV1,
    payload: NewAppTableImport,
    context: WorkerMutationContext,
  ): Promise<NewAppImportResult> {
    return this.mutationCall("importNewApp", {
      ...(typeof binding === "string" ? { createRequestId: binding } : { firstRunTarget: binding }), payload,
    }, context);
  }
  undoNewAppImport(
    binding: string | TargetEvidenceV1,
    importRequestId: string,
    context: WorkerMutationContext,
  ): Promise<Readonly<{ appInstanceId: string; undone: true; version: 0 }>> {
    return this.mutationCall(
      "undoNewAppImport", {
        ...(typeof binding === "string" ? { createRequestId: binding } : { firstRunTarget: binding }), importRequestId,
      }, context,
    );
  }
  async status(): Promise<StatusInfo> {
    const access = Object.freeze({ ...this.#modelAccess });
    const status = await this.ephemeralCall<Omit<StatusInfo, "modelConnection">>("status");
    return { ...status, modelConnection: await this.#modelConnection(access) };
  }
  async requestPersist(): Promise<Readonly<{ persisted: boolean }>> {
    const result = await this.ephemeralCall<unknown>("requestPersist");
    if (!exactRecord(result, ["persisted"]) || typeof result.persisted !== "boolean")
      throw new Error("invalid persistence permission response");
    return Object.freeze({ persisted: result.persisted });
  }
  seed(shellId: string, context: WorkerMutationContext): Promise<null> {
    return this.mutationCall("seed", { shellId }, context);
  }
  panels(): Promise<LivePanel[]> { return this.ephemeralCall("panels"); }
  panelProvenance(): Promise<PanelProvenance[]> { return this.ephemeralCall("panelProvenance"); }
  semanticTrace(): Promise<SemanticSchemaTraceV1> { return this.ephemeralCall("semanticTrace"); }
  fieldProvenance(): Promise<FieldProvenance[]> { return this.ephemeralCall("fieldProvenance"); }
  recordPrivateMetric(event: PrivateMetricEvent, context: WorkerMutationContext): Promise<null> {
    return this.mutationCall("recordPrivateMetric", { event }, context);
  }
  privateMetricsSummary(): Promise<PrivateMetricsSummary> {
    return this.ephemeralCall("privateMetricsSummary");
  }
  setPrivateMetricsEnabled(
    enabled: boolean, context: WorkerMutationContext,
  ): Promise<PrivateMetricsSummary> {
    return this.mutationCall("setPrivateMetricsEnabled", { enabled }, context);
  }
  clearPrivateMetrics(context: WorkerMutationContext): Promise<PrivateMetricsSummary> {
    return this.mutationCall("clearPrivateMetrics", undefined, context);
  }
  commitLayout(
    placements: { panel_id: string; region: "top" | "main" | "side"; order: number; w?: number; h?: number; col?: number | null }[],
    context: WorkerMutationContext,
  ): Promise<LivePanel[]> {
    return this.mutationCall("commitLayout", { placements }, context);
  }
  renamePanel(panelId: string, title: string, context: WorkerMutationContext): Promise<LivePanel[]> {
    return this.mutationCall("renamePanel", { panelId, title }, context);
  }
  addAttachment(input: {
    table: string; rowId: string; field: string; name: string; mime: string; bytes: ArrayBuffer;
  }, context: WorkerMutationContext): Promise<AttachmentMetadata> {
    return this.mutationCall("addAttachment", input, context, [input.bytes]);
  }
  attachmentsForRecord(table: string, rowId: string, field: string): Promise<AttachmentMetadata[]> {
    return this.ephemeralCall("attachmentsForRecord", { table, rowId, field });
  }
  readAttachment(id: string): Promise<AttachmentFile> {
    return this.ephemeralCall("readAttachment", { id });
  }
  removeAttachment(
    table: string, rowId: string, field: string, id: string,
    context: WorkerMutationContext,
  ): Promise<null> {
    return this.mutationCall("removeAttachment", { table, rowId, field, id }, context);
  }
  attachmentStorage(): Promise<AttachmentStorageSummary> {
    return this.ephemeralCall("attachmentStorage", {});
  }
  purgeDeletedAttachments(
    context: WorkerMutationContext,
  ): Promise<{ files: number; bytes: number }> {
    return this.mutationCall("purgeDeletedAttachments", {}, context);
  }
  listIntakeForms(): Promise<LocalIntakeFormV1[]> {
    return this.ephemeralCall("listIntakeForms", {});
  }
  saveIntakeForm(
    form: LocalIntakeFormV1,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<LocalIntakeFormV1> {
    return this.mutationCall("saveIntakeForm", { form }, context);
  }
  markIntakeFormPublished(
    formId: string,
    publishedAt: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<LocalIntakeFormV1> {
    return this.mutationCall("markIntakeFormPublished", { formId, publishedAt }, context);
  }
  revokeIntakeForm(
    formId: string,
    revokedAt: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<LocalIntakeFormV1> {
    return this.mutationCall("revokeIntakeForm", { formId, revokedAt }, context);
  }
  markIntakeFormExpired(
    formId: string,
    expiredAt: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<LocalIntakeFormV1> {
    return this.mutationCall("markIntakeFormExpired", { formId, expiredAt }, context);
  }
  intakeInbox(): Promise<IntakeInboxItem[]> {
    return this.ephemeralCall("intakeInbox", {});
  }
  intakeReceipts(): Promise<IntakeAcceptanceReceipt[]> {
    return this.ephemeralCall("intakeReceipts", {});
  }
  intakeDeliveryFailures(): Promise<IntakeDeliveryFailure[]> {
    return this.ephemeralCall("intakeDeliveryFailures", {});
  }
  recordIntakeDeliveryFailure(
    input: { formId: string; submissionId: string; envelopeSha256: string; failedAt: string },
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeDeliveryFailure> {
    return this.mutationCall("recordIntakeDeliveryFailure", { failure: input }, context);
  }
  authorizeIntakeDeliveryDiscard(
    formId: string,
    submissionId: string,
    authorizedAt: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeDeliveryFailure> {
    return this.mutationCall(
      "authorizeIntakeDeliveryDiscard", { formId, submissionId, authorizedAt }, context,
    );
  }
  resolveIntakeDeliveryFailure(
    formId: string,
    submissionId: string,
    resolution: "staged" | "discarded",
    resolvedAt: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeDeliveryFailure | null> {
    return this.mutationCall("resolveIntakeDeliveryFailure", {
      formId, submissionId, resolution, resolvedAt,
    }, context);
  }
  stageIntakeSubmission(
    submission: IntakeSubmissionPlaintextV1,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeInboxItem> {
    return this.mutationCall("stageIntakeSubmission", { submission }, context);
  }
  rejectIntakeSubmission(
    submissionId: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeInboxItem> {
    return this.mutationCall("rejectIntakeSubmission", { submissionId }, context);
  }
  simulateIntakeAutoAccept(
    draft: IntakeAutoAcceptDraftV1,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeAutoAcceptSimulation> {
    return this.mutationCall("simulateIntakeAutoAccept", { draft }, context);
  }
  enableIntakeAutoAccept(
    draft: IntakeAutoAcceptDraftV1,
    simulationFingerprint: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeAutoAcceptRuleV1> {
    return this.mutationCall("enableIntakeAutoAccept", { draft, simulationFingerprint }, context);
  }
  disableIntakeAutoAccept(
    formId: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<null> {
    return this.mutationCall("disableIntakeAutoAccept", { formId }, context);
  }
  processIntakeAutoAccept(
    formId: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeAcceptanceReceipt[]> {
    return this.mutationCall("processIntakeAutoAccept", { formId }, context);
  }
  acceptIntakeSubmission(
    submissionId: string,
    approvedFileIds: string[],
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeAcceptanceReceipt> {
    return this.mutationCall("acceptIntakeSubmission", {
      submissionId, mode: "manual", approvedFileIds,
    }, context);
  }
  undoIntakeReceipt(
    receiptId: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<IntakeAcceptanceReceipt> {
    return this.mutationCall("undoIntakeReceipt", { receiptId }, context);
  }
  automationRecipes(): Promise<AutomationRecipeCardV1[]> {
    return this.ephemeralCall("automationRecipes", {});
  }
  automationRuntimeStatus(): Promise<AutomationRuntimeStatusV1> {
    return this.ephemeralCall("automationRuntimeStatus", {});
  }
  automationRuntimeOverview(limit = 100): Promise<AutomationRuntimeOverviewV1> {
    return this.ephemeralCall("automationRuntimeOverview", { limit });
  }
  listAutomations(): Promise<AutomationDefinitionAny[]> {
    return this.ephemeralCall("listAutomations", {});
  }
  /** Legacy V1 import/edit path. enabled=true is rejected by the kernel. */
  upsertAutomation(
    input: AutomationDefinitionInput,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationDefinition> {
    return this.mutationCall("upsertAutomation", { input }, context);
  }
  saveAutomationDraft(
    input: AutomationDraftInputV2,
    expectedRevision?: number,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationDefinitionV2> {
    return this.mutationCall(
      "saveAutomationDraft", { input, expectedRevision: expectedRevision ?? null }, context,
    );
  }
  saveAutomationRecipeDraft(
    request: AutomationRecipeDraftRequestV1,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationDefinitionV2> {
    return this.mutationCall("saveAutomationRecipeDraft", { request }, context);
  }
  deleteAutomation(
    id: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<null> {
    return this.mutationCall("deleteAutomation", { id }, context);
  }
  simulateAutomation(
    id: string,
    expectedRevision?: number,
    purpose?: "enable" | "run_now" | "proposal_review",
  ): Promise<AutomationSimulationProofV1> {
    return this.ephemeralCall("simulateAutomation", { id,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(purpose === undefined ? {} : { purpose }),
    });
  }
  enableAutomation(
    id: string,
    expectedRevision: number,
    simulation: AutomationSimulationProofV1,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationDefinitionV2> {
    return this.mutationCall("enableAutomation", { id, expectedRevision, simulation }, context);
  }
  pauseAutomation(
    id: string,
    expectedRevision: number,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationDefinitionV2> {
    return this.mutationCall("pauseAutomation", { id, expectedRevision }, context);
  }
  runAutomations(
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationRun[]> {
    return this.mutationCall("runAutomations", {}, context);
  }
  runAutomationNow(
    id: string,
    expectedRevision: number,
    simulation: AutomationSimulationProofV1,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationExecutionResultV1> {
    return this.mutationCall("runAutomationNow", { id, expectedRevision, simulation }, context);
  }
  automationRuns(automationId?: string, limit = 100): Promise<AutomationRun[]> {
    return this.ephemeralCall("automationRuns", { automationId: automationId ?? null, limit });
  }
  undoAutomationRun(
    id: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<AutomationRun> {
    return this.mutationCall("undoAutomationRun", { id }, context);
  }
  private dailyHomeRuntimeTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  private async ensureDailyHomeTimeZone(): Promise<void> {
    if (await this.getSetting("daily_time_zone_v1") === null)
      await this.initializeDailyHomeTimeZone(this.dailyHomeRuntimeTimeZone(), this.createMutationContext());
  }
  async dailyHome(): Promise<DailyHomeSnapshot> {
    await this.ensureDailyHomeTimeZone();
    return this.ephemeralCall("dailyHome");
  }
  async resolveDailyHomeDate(value: string): Promise<string> {
    await this.ensureDailyHomeTimeZone();
    return this.ephemeralCall("dailyHomeResolveDate", { value });
  }
  compareAndSetDailySource<T>(
    expectedRevision: number, value: T,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<{ ok: boolean; current: unknown }> {
    return this.mutationCall("dailyHomeSourceCompareAndSet", { expectedRevision, value }, context);
  }
  compareAndSetDailyNavigation<T>(
    expectedRevision: number, value: T,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): Promise<{ ok: boolean; current: unknown }> {
    return this.mutationCall("dailyHomeNavigationCompareAndSet", { expectedRevision, value }, context);
  }
  initializeDailyHomeTimeZone(timeZone: string, context: WorkerMutationContext = createWorkerMutationContext()): Promise<string> {
    return this.mutationCall("dailyHomeInitializeTimeZone", { timeZone }, context);
  }
  quickCapture(table: string, row: Record<string, unknown>, tableId: string, context: WorkerMutationContext = createWorkerMutationContext()): Promise<BatchReceipt> {
    return this.mutationCall("dailyHomeQuickCapture", { table, row, tableId }, context);
  }
  undoQuickCapture(batchId: string, context: WorkerMutationContext = createWorkerMutationContext()): Promise<BatchReceipt> {
    return this.mutationCall("dailyHomeUndoCapture", { batchId }, context);
  }
  async rememberDailyRecordOpened(tableId: string, rowId: string): Promise<void> {
    const navigation = await import("@clay/kernel/daily-navigation");
    await navigation.rememberDailyRecordOpened(this, { tableId, rowId });
  }
  async toggleDailyFavorite(tableId: string, rowId: string): Promise<void> {
    const navigation = await import("@clay/kernel/daily-navigation");
    await navigation.toggleDailyFavorite(this, { tableId, rowId });
  }
  notifications(limit = 100): Promise<ClayNotification[]> {
    return this.ephemeralCall("notifications", { limit });
  }
  markNotificationRead(
    id: string,
    context: WorkerMutationContext = createWorkerMutationContext(),
  ): DurableMutationPromise<null> {
    return this.mutationCall("markNotificationRead", { id }, context);
  }  globalSearch(term: string, limit = 20): Promise<GlobalSearchResult[]> {
    return this.ephemeralCall("globalSearch", { term, limit });
  }
  applyBatch(
    summary: string,
    mutations: BatchMutation[],
    context: WorkerMutationContext,
  ): Promise<BatchReceipt> {
    return this.mutationCall("applyBatch", { source: "user", summary, mutations }, context);
  }
  operationBatches(limit = 50): Promise<BatchReceipt[]> {
    return this.ephemeralCall("operationBatches", { limit });
  }
  undoBatch(id: string, context: WorkerMutationContext): Promise<BatchReceipt> {
    return this.mutationCall("undoBatch", { id }, context);
  }
  beginImport(
    descriptor: ImportSourceDescriptor,
    targetTable: string,
    sheetId?: string,
  ): Promise<ImportStructure> {
    return this.ephemeralCall("beginImport", {
      descriptor, targetTable, ...(sheetId === undefined ? {} : { sheetId }),
    });
  }
  stageImportChunk(appInstanceId: string, chunk: ImportParserChunk): Promise<ImportStructure> {
    return this.ephemeralCall("stageImportChunk", { appInstanceId, chunk });
  }
  importStructure(sessionId: string, header?: ImportHeaderChoice): Promise<ImportStructure> {
    return this.ephemeralCall("importStructure", {
      sessionId, ...(header === undefined ? {} : { header }),
    });
  }
  configureImport(input: ConfigureImportInput): Promise<null> {
    return this.ephemeralCall("configureImport", input as unknown as Record<string, unknown>);
  }
  previewImport(sessionId: string): Promise<ImportCoordinatorPreview> {
    return this.ephemeralCall("previewImport", { sessionId });
  }
  commitImport(input: {
    sessionId: string; previewId: string; previewDigest: string; idempotencyKey: string;
  }, context: WorkerMutationContext = createWorkerMutationContext()): Promise<CommitImportResult> {
    return this.mutationCall("commitImport", input, context);
  }
  cancelImport(sessionId: string): Promise<{ disposed: true }> {
    return this.ephemeralCall("cancelImport", { sessionId });
  }
  undoImport(id: string, context: WorkerMutationContext = createWorkerMutationContext()): Promise<ImportReceipt> {
    return this.mutationCall("undoImport", { id }, context);
  }
  rowHistory(table: string, id: string):
    Promise<{ at: string; values: Record<string, unknown> }[]> {
    return this.ephemeralCall("rowHistory", { table, id });
  }
  previewRelationConversion(input: RelationConversionRequest): Promise<RelationConversionPreview> {
    return this.ephemeralCall("previewRelationConversion", input);
  }
  convertTextToRelation(
    input: RelationConversionPreview & { cardinality: "one" },
    context: WorkerMutationContext,
  ): Promise<RelationConversionResult> {
    return this.mutationCall("convertTextToRelation", input, context);
  }
  addColumn(
    table: string,
    column: { name: string; type: string } & Record<string, unknown>,
    context: WorkerMutationContext,
  ):
    Promise<RegTable[]> {
    return this.mutationCall("addColumn", { table, column }, context);
  }
  addRelationColumn(
    table: string,
    column: { name: string; type: "relation"; relation: RelationFieldSpec } & Record<string, unknown>,
    context: WorkerMutationContext,
  ): Promise<RegTable[]> {
    return this.mutationCall("addRelationColumn", { table, column }, context);
  }
  renameColumn(
    table: string, from: string, to: string, context: WorkerMutationContext,
  ): Promise<RegTable[]> {
    return this.mutationCall("renameColumn", { table, from, to }, context);
  }
  removeColumn(table: string, column: string, context: WorkerMutationContext): Promise<RegTable[]> {
    return this.mutationCall("removeColumn", { table, column }, context);
  }
  removePanel(panelId: string, context: WorkerMutationContext): Promise<LivePanel[]> {
    return this.mutationCall("removePanel", { panelId }, context);
  }
  history(): Promise<HistoryEntry[]> { return this.ephemeralCall("history"); }
  setCheckpoint(
    version: number, label: string, context: WorkerMutationContext,
  ): Promise<HistoryEntry[]> {
    return this.mutationCall("setCheckpoint", { version, label }, context);
  }
  panelsAt(version: number): Promise<LivePanel[]> {
    return this.ephemeralCall("panelsAt", { version });
  }
  makeLatest(version: number, context: WorkerMutationContext): Promise<LivePanel[]> {
    return this.mutationCall("makeLatest", { version }, context);
  }
  intent(text: string, context: WorkerMutationContext): Promise<IntentOutcome> {
    if (typeof text !== "string" || containsProtectedSecret(text, this.#protectedSecrets))
      return Promise.reject(new ClayError(
        "E_VALIDATION", "Intent cannot contain active credential material",
      ));
    return this.#plannerCall("intent", { text }, context);
  }
  repairPanel(
    panelId: string, _error: string, context: WorkerMutationContext,
  ): Promise<IntentOutcome> {
    return this.#plannerCall("repairPanel", { panelId }, context);
  }
  revertPanel(panelId: string, context: WorkerMutationContext): Promise<LivePanel[]> {
    return this.mutationCall("revertPanel", { panelId }, context);
  }
  keep(context: WorkerMutationContext): Promise<{ version: number }> {
    return this.mutationCall("keep", undefined, context);
  }
  discard(context: WorkerMutationContext): Promise<null> {
    return this.mutationCall("discard", undefined, context);
  }
  removeSamples(context: WorkerMutationContext): Promise<{
    affected: number;
    recovery: { kind: "soft_delete"; recoverable: number };
  }> { return this.mutationCall("removeSamples", {}, context); }
  fillSamples(context: WorkerMutationContext): Promise<{ added: number; tables: number }> {
    return this.mutationCall("fillSamples", undefined, context);
  }
  sampleCount(): Promise<number> { return this.ephemeralCall("sampleCount"); }
  firstRunEvidence(): Promise<{
    sampleCount: number; sampleTables: string[]; realRecordCount: number; provenanceValid: boolean;
  }> {
    return this.ephemeralCall("firstRunEvidence");
  }
  firstEverydayActionTarget(): Promise<{ table: string; rowId: string } | null> {
    return this.ephemeralCall("firstEverydayActionTarget");
  }
  completeEverydayAction(input: {
    action: "open"; table: string; rowId: string;
  }, context: WorkerMutationContext): Promise<FirstSuccessState> {
    return this.mutationCall(
      "completeEverydayAction",
      input,
      context,
    );
  }
  deviceProtection(): Promise<import("../worker/db-worker").DeviceProtectionProjection> {
    return this.ephemeralCall("deviceProtection");
  }
  registryTables(): Promise<RegTable[]> { return this.ephemeralCall("registryTables"); }
  async projectExport(
    request: ProjectionRequestV1, signal?: AbortSignal,
  ): Promise<ProjectionArtifactV1> {
    const transported = await this.callProjection(request, signal);
    const canonicalProjection = decodeProjectionTransportV1(transported);
    return Object.freeze({
      projection: canonicalProjection,
      plaintext: transported.plaintext,
      csv: transported.csv,
    });
  }
  restoreRow(
    table: string, id: string, context: WorkerMutationContext,
  ): Promise<Record<string, unknown>> {
    return this.mutationCall("restoreRow", { table, id }, context);
  }
  restorableRows(table: string): Promise<string[]> {
    return this.ephemeralCall("restorableRows", { table });
  }
  suggestions(): Promise<Suggestion[]> { return this.ephemeralCall("suggestions"); }
  debugLog(): Promise<TraceEntry[]> { return this.ephemeralCall("debugLog"); }
  recordFilter(name: string, payload: unknown, context: WorkerMutationContext): Promise<null> {
    return this.mutationCall("recordFilter", { name, payload }, context);
  }
  dismissSuggestion(
    subject: string, kind: string, context: WorkerMutationContext,
  ): Promise<null> {
    return this.mutationCall("dismissSuggestion", { subject, kind }, context);
  }
  acceptSuggestion(
    subject: string, kind: string, context: WorkerMutationContext,
  ): Promise<null> {
    return this.mutationCall("acceptSuggestion", { subject, kind }, context);
  }
  backupSelection(context: WorkerMutationContext = createWorkerMutationContext()): Promise<ProductionBackupSelection> {
    return this.mutationCall("backupSelection", undefined, context);
  }
  backupRecords(): Promise<BackupRecord[]> {
    return this.ephemeralCall("backupRecords");
  }
  manualBackupDownloads(): Promise<import("@clay/schema/backup").ManualBackupDownloadV2[]> {
    return this.ephemeralCall("manualBackupDownloads");
  }
  recordManualBackupDownload(record: import("@clay/schema/backup").ManualBackupDownloadV2, context: WorkerMutationContext): Promise<import("@clay/schema/backup").ManualBackupDownloadV2> {
    return this.mutationCall("recordManualBackupDownload", { record }, context);
  }
  #backupRuntime: Promise<import("./trusted-backup-runtime").TrustedBackupRuntime> | null = null;
  private trustedBackupRuntime(): Promise<import("./trusted-backup-runtime").TrustedBackupRuntime> {
    return this.#backupRuntime ??= import("./trusted-backup-runtime").then(({ TrustedBackupRuntime }) => new TrustedBackupRuntime({
      backupSelection: expected => expected
        ? this.mutationCall("backupSelection", { expected }, createWorkerMutationContext()) : this.backupSelection(),
      backupRecords: () => this.ephemeralCall("backupRecords", { allApps: true }),
      collectArchiveSnapshot: () => this.ephemeralCall("collectArchiveSnapshot"),
      validateArchive: (bytes, expected, port) => this.ephemeralCall("validateBackupStage", { bytes, expected }, [bytes, port]),
      publishBackup: request => this.mutationCall("publishBackup", { request }, createWorkerMutationContext()),
    })).catch(error => { this.#backupRuntime = null; throw error; });
  }
  async prepareAutomaticBackup(
    target: BackupRun["target"],
    reason: BackupRun["reason"],
  ): Promise<{ run: BackupRun; bytes: ArrayBuffer }> {
    const prepared = await (await this.trustedBackupRuntime()).automatic.prepare(target, reason);
    return { run: prepared.run, bytes: prepared.bytes.slice().buffer };
  }
  async validateBackupStage(
    bytes: ArrayBuffer,
    expected: ProductionBackupSelection["selected"]["target"],
  ): Promise<BackupStageValidation> {
    return (await this.trustedBackupRuntime()).automatic.validateStage(new Uint8Array(bytes), expected);
  }
  async publishBackup(request: BackupPublicationRequest): Promise<BackupPublicationReceipt> {
    return (await this.trustedBackupRuntime()).automatic.publish(request);
  }
  async backupTrustStatus(): Promise<BackupTrustRuntimeStatus> {
    return (await this.trustedBackupRuntime()).trust.status();
  }
  async beginBackupTrustEnrollment(): Promise<RecoveryKitEnrollment> {
    return (await this.trustedBackupRuntime()).trust.beginEnrollment();
  }
  async confirmBackupTrustEnrollment(
    enrollmentId: string,
    recoveryKitBytes: ArrayBuffer,
  ): Promise<BackupTrustRuntimeStatus> {
    try { return await (await this.trustedBackupRuntime()).trust.confirmEnrollment(enrollmentId, new Uint8Array(recoveryKitBytes)); }
    finally { new Uint8Array(recoveryKitBytes).fill(0); }
  }
  async importRecoveryKit(recoveryKitBytes: ArrayBuffer): Promise<RecoveryKitImportResult> {
    try { return await (await this.trustedBackupRuntime()).trust.importRecoveryKit(new Uint8Array(recoveryKitBytes)); }
    finally { new Uint8Array(recoveryKitBytes).fill(0); }
  }
  async activateImportedBackupSeries(
    seriesId: string,
    expectedActiveSeriesId: string | null,
  ): Promise<BackupTrustRuntimeStatus> {
    return (await this.trustedBackupRuntime()).trust.activateImportedSeries({ seriesId, expectedActiveSeriesId,
      confirmation: "use_imported_recovery_kit_for_future_backups" });
  }
  recoveryCandidates(): Promise<RecoveryRecordCandidate[]> {
    return this.ephemeralCall("recoveryCandidates");
  }
  async validateRestoreArchive(bytes: ArrayBuffer): Promise<AuthenticatedFormat5RestoreGrant> {
    const runtime = await this.trustedBackupRuntime();
    const { serveArchiveVerification } = await import("./archive-verification");
    const channel = new MessageChannel();
    const stop = serveArchiveVerification(channel.port1, runtime.trust);
    try { return await this.ephemeralCall("validateRestoreArchive", { bytes }, [bytes, channel.port2]); }
    finally { stop(); channel.port2.close(); }
  }
  restoreAsNew(grant: AuthenticatedFormat5RestoreGrant, context: WorkerMutationContext): Promise<BootInfo> {
    return this.mutationCall(
      "restoreAsNew", { grant }, context,
    );
  }
  async exportArchive(): Promise<{ bytes: ArrayBuffer; filename: string;
    download: Omit<import("@clay/schema/backup").ManualBackupDownloadV2, "startedAt"> }> {
    const exported = await (await this.trustedBackupRuntime()).automatic.prepareManualDownload();
    try {
      const { archiveDigest } = await import("../worker/archive-verification-channel");
      const archiveSha256 = await archiveDigest(exported.bytes);
      return { bytes: exported.bytes.slice().buffer, filename: exported.filename,
        download: { schema: 2, kind: "manual_download", archiveFormat: 5,
          fileName: exported.filename, byteLength: exported.bytes.byteLength, archiveSha256,
          authentication: exported.authentication, evidence: exported.target, verification: "unverified_external_save" } };
    } finally { exported.bytes.fill(0); }
  }
  getSetting<T>(key: string): Promise<T | null> {
    return this.ephemeralCall("getSetting", { key });
  }
  setSetting(key: string, value: unknown, context: WorkerMutationContext): Promise<null> {
    return this.mutationCall("setSetting", { key, value }, context);
  }
  deleteSetting(key: string, context: WorkerMutationContext): Promise<null> {
    return this.mutationCall("deleteSetting", { key }, context);
  }
  compareAndSetSetting<T>(
    key: string, expectedRevision: number, value: T, context: WorkerMutationContext,
  ): Promise<{ ok: boolean; current: unknown }> {
    return this.mutationCall("compareAndSetSetting", { key, expectedRevision, value }, context);
  }

  /** Open a serveStore RPC port on the worker for the Bridge's AsyncStore. */
  openStorePort(target: "live" | "shadow"): MessagePort {
    if (!this.#accepting) throw new Error("DB worker shutdown is in progress");
    const channel = new MessageChannel();
    void this.ephemeralCall("storePort", { target }, [channel.port2]);
    channel.port1.start();
    return channel.port1;
  }
}
