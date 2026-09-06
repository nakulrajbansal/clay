import { MutationPlan } from "@clay/schema";
import { ClayError } from "./errors";
import { cloneFieldSemantic, cloneTableSemantic } from "./registry";
import { parseFieldId, parseRelationshipId, parseTableId } from "./semantic";
import type {
  FieldId,
  PreparedSemanticAssignmentsV1,
  RelationshipId,
  SemanticOrigin,
  SemanticRelationshipRecordV1,
  TableId,
} from "./semantic";

export type PreparedMutationBase = Readonly<{
  version: number;
  shapeSha256: string;
}>;

export type PreparedSemanticIdEntry<Id extends string> = Readonly<{
  key: string;
  id: Id;
}>;

export type PreparedSemanticAssignmentsDataV1 = Readonly<{
  schema: 1;
  version: number;
  origin: SemanticOrigin;
  tables: readonly PreparedSemanticIdEntry<TableId>[];
  fields: readonly PreparedSemanticIdEntry<FieldId>[];
  relationships: readonly PreparedSemanticIdEntry<RelationshipId>[];
}>;

export type PreparedMutationCommand = Readonly<{
  schema: 1;
  attemptId: string;
  base: PreparedMutationBase;
  intent: string;
  plan: MutationPlan;
  semanticAssignments: PreparedSemanticAssignmentsDataV1;
}>;

export type PreparedPreviewInput = Readonly<{
  attemptId: string;
  base: PreparedMutationBase;
  intent: string;
  plan: MutationPlan;
}>;

type StrictData = null | boolean | number | string | StrictData[] | StrictRecord;
type StrictRecord = { [key: string]: StrictData };
type CaptureBudget = { nodes: number; bytes: number };

const MAX_CAPTURE_DEPTH = 32;
const MAX_CAPTURE_NODES = 50_000;
const MAX_CAPTURE_STRING_LENGTH = 1_000_000;
const MAX_CAPTURE_BYTES = 2_000_000;
const MAX_CAPTURE_ARRAY = 20_000;
const MAX_CAPTURE_RECORD_KEYS = 512;
const MAX_CAPTURE_KEY_LENGTH = 256;
const CAPTURE_ENCODER = new TextEncoder();

function consumeCaptureBytes(budget: CaptureBudget, bytes: number): void {
  budget.bytes += bytes;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_CAPTURE_BYTES)
    throw new ClayError("E_LIMIT", "prepared mutation request exceeds the aggregate byte limit");
}

function chargeJsonText(value: string, budget: CaptureBudget): void {
  consumeCaptureBytes(budget, CAPTURE_ENCODER.encode(JSON.stringify(value)).byteLength);
}

function strictInvalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

function captureStrictData(
  input: unknown,
  seen: WeakSet<object>,
  budget: CaptureBudget,
  depth = 0,
): StrictData {
  budget.nodes += 1;
  if (depth > MAX_CAPTURE_DEPTH || budget.nodes > MAX_CAPTURE_NODES)
    throw new ClayError("E_LIMIT", "prepared mutation command exceeds structural limits");
  if (input === null) {
    consumeCaptureBytes(budget, 4);
    return input;
  }
  if (typeof input === "boolean") {
    consumeCaptureBytes(budget, input ? 4 : 5);
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw strictInvalid("prepared command contains a non-finite number");
    consumeCaptureBytes(budget, CAPTURE_ENCODER.encode(JSON.stringify(input)).byteLength);
    return input;
  }
  if (typeof input === "string") {
    if (input.length > MAX_CAPTURE_STRING_LENGTH)
      throw new ClayError("E_LIMIT", "prepared mutation command exceeds string limits");
    chargeJsonText(input, budget);
    return input;
  }
  if (typeof input !== "object")
    throw strictInvalid("prepared command contains unsupported data");
  if (seen.has(input)) throw strictInvalid("prepared command contains a cycle");
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      if (Reflect.getPrototypeOf(input) !== Array.prototype)
        throw strictInvalid("prepared command arrays must use the standard prototype");
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(input, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor))
        throw strictInvalid("prepared command arrays must have a data length");
      const rawLength: unknown = lengthDescriptor.value;
      if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength)
          || rawLength < 0 || rawLength > MAX_CAPTURE_ARRAY)
        throw new ClayError("E_LIMIT", "prepared command array exceeds limits");
      const length = rawLength;
      const keys = Reflect.ownKeys(input);
      if (keys.length !== length + 1 || keys.some(key => typeof key !== "string"))
        throw strictInvalid("prepared command arrays must be dense standard arrays");
      consumeCaptureBytes(budget, 2 + Math.max(0, length - 1));
      const output = new Array<StrictData>(length);
      for (let index = 0; index < length; index++) {
        const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw strictInvalid("prepared command arrays must contain enumerable data entries");
        output[index] = captureStrictData(descriptor.value, seen, budget, depth + 1);
      }
      return output;
    }
    const prototype = Reflect.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      throw strictInvalid("prepared command records must be plain data records");
    const keys = Reflect.ownKeys(input);
    if (keys.length > MAX_CAPTURE_RECORD_KEYS
        || keys.some(key => typeof key !== "string" || key.length > MAX_CAPTURE_KEY_LENGTH))
      throw new ClayError("E_LIMIT", "prepared command record exceeds limits");
    consumeCaptureBytes(budget, 2 + Math.max(0, keys.length - 1));
    const output: StrictRecord = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string")
        throw strictInvalid("prepared command symbols are not allowed");
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw strictInvalid("prepared command fields must be enumerable data properties");
      chargeJsonText(key, budget);
      consumeCaptureBytes(budget, 1);
      output[key] = captureStrictData(descriptor.value, seen, budget, depth + 1);
    }
    return output;
  } finally {
    seen.delete(input);
  }
}

function captureCompleteStrictData(input: unknown): StrictData {
  const captured = captureStrictData(input, new WeakSet(), { nodes: 0, bytes: 0 });
  try {
    // The descriptor walk above rejects accessors before this operation can
    // invoke one. Native structured clone then supplies the browser-standard
    // fail-closed check which transparent Proxy wrappers cannot spoof.
    structuredClone(input);
  } catch {
    throw strictInvalid("prepared mutation request must not contain proxies or exotic data");
  }
  return captured;
}

/** Capture an untrusted model plan before normalization, Zod, or Validator
 * code can observe caller-owned properties. */
export function capturePlannerPlanData(input: unknown): unknown {
  return captureCompleteStrictData(input);
}

function strictRecord(input: StrictData, label: string): StrictRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw strictInvalid(`${label} must be a data record`);
  return input;
}

function exactFields(record: StrictRecord, fields: readonly string[], label: string): void {
  const keys = Object.keys(record);
  const expected = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => !expected.has(key)))
    throw strictInvalid(`${label} fields are invalid`);
}

function requiredData(record: StrictRecord, key: string, label: string): StrictData {
  const value = record[key];
  if (value === undefined) throw strictInvalid(`${label} is missing`);
  return value;
}

function boundedString(value: StrictData, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max)
    throw strictInvalid(`${label} is invalid`);
  return value;
}

function safeNonnegativeInteger(value: StrictData, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw strictInvalid(`${label} is invalid`);
  return value;
}

function stableData(input: StrictData): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) {
    let output = "[";
    for (let index = 0; index < input.length; index++)
      output += `${index === 0 ? "" : ","}${stableData(input[index]!)}`;
    return `${output}]`;
  }
  const keys = Object.keys(input).sort();
  let output = "{";
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    output += `${index === 0 ? "" : ","}${JSON.stringify(key)}:${stableData(input[key]!)}`;
  }
  return `${output}}`;
}

function parseSemanticEntries<Id extends string>(
  input: StrictData,
  kind: string,
  limit: number,
  parseId: (value: unknown) => Id,
): readonly PreparedSemanticIdEntry<Id>[] {
  if (!Array.isArray(input) || input.length > limit)
    throw new ClayError("E_LIMIT", `prepared ${kind} assignments exceed limits`);
  const entries: PreparedSemanticIdEntry<Id>[] = [];
  const ids = new Set<Id>();
  let priorKey: string | null = null;
  for (const raw of input) {
    const entry = strictRecord(raw, `prepared ${kind} assignment`);
    exactFields(entry, ["key", "id"], `prepared ${kind} assignment`);
    const key = boundedString(
      requiredData(entry, "key", `prepared ${kind} key`),
      `prepared ${kind} key`, 1, 256,
    );
    if (priorKey !== null && key <= priorKey)
      throw strictInvalid(`prepared ${kind} assignments must be uniquely sorted`);
    priorKey = key;
    let id: Id;
    try { id = parseId(requiredData(entry, "id", `prepared ${kind} identity`)); }
    catch { throw strictInvalid(`prepared ${kind} identity is invalid`); }
    if (ids.has(id)) throw strictInvalid(`prepared ${kind} identities must be unique`);
    ids.add(id);
    entries.push(Object.freeze({ key, id }));
  }
  return Object.freeze(entries);
}

export function capturePreparedMutationCommand(input: unknown): PreparedMutationCommand {
  const captured = strictRecord(captureCompleteStrictData(input), "prepared mutation command");
  exactFields(
    captured,
    ["schema", "attemptId", "base", "intent", "plan", "semanticAssignments"],
    "prepared mutation command",
  );
  if (requiredData(captured, "schema", "prepared mutation command schema") !== 1)
    throw strictInvalid("prepared mutation command schema is invalid");
  const attemptId = boundedString(
    requiredData(captured, "attemptId", "prepared attempt id"),
    "prepared attempt id", 36, 36,
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId))
    throw strictInvalid("prepared attempt id is invalid");
  const baseRecord = strictRecord(
    requiredData(captured, "base", "prepared mutation base"), "prepared mutation base",
  );
  exactFields(baseRecord, ["version", "shapeSha256"], "prepared mutation base");
  const base = Object.freeze({
    version: safeNonnegativeInteger(
      requiredData(baseRecord, "version", "prepared base version"), "prepared base version",
    ),
    shapeSha256: boundedString(
      requiredData(baseRecord, "shapeSha256", "prepared base shape digest"),
      "prepared base shape digest", 71, 71,
    ),
  });
  if (!/^sha256:[0-9a-f]{64}$/.test(base.shapeSha256))
    throw strictInvalid("prepared base shape digest is invalid");
  const intent = boundedString(
    requiredData(captured, "intent", "prepared intent"), "prepared intent", 1, 500,
  );
  const capturedPlan = requiredData(captured, "plan", "prepared mutation plan");
  const parsedPlan = MutationPlan.safeParse(capturedPlan);
  if (!parsedPlan.success || parsedPlan.data.clarifying_question !== null)
    throw strictInvalid("prepared mutation plan is invalid");
  if (stableData(capturedPlan) !== stableData(parsedPlan.data as unknown as StrictData))
    throw strictInvalid("prepared mutation plan has non-canonical fields");
  const semanticRecord = strictRecord(
    requiredData(captured, "semanticAssignments", "prepared semantic assignments"),
    "prepared semantic assignments",
  );
  exactFields(
    semanticRecord,
    ["schema", "version", "origin", "tables", "fields", "relationships"],
    "prepared semantic assignments",
  );
  if (requiredData(semanticRecord, "schema", "prepared semantic schema") !== 1
      || requiredData(semanticRecord, "origin", "prepared semantic origin") !== "model")
    throw strictInvalid("prepared semantic assignment header is invalid");
  const semanticVersion = safeNonnegativeInteger(
    requiredData(semanticRecord, "version", "prepared semantic assignment version"),
    "prepared semantic assignment version",
  );
  if (semanticVersion !== base.version + 1)
    throw strictInvalid("prepared semantic assignments target another base");
  const semanticAssignments: PreparedSemanticAssignmentsDataV1 = Object.freeze({
    schema: 1,
    version: semanticVersion,
    origin: "model",
    tables: parseSemanticEntries(
      requiredData(semanticRecord, "tables", "prepared table assignments"),
      "table", 256, parseTableId,
    ),
    fields: parseSemanticEntries(
      requiredData(semanticRecord, "fields", "prepared field assignments"),
      "field", 4_096, parseFieldId,
    ),
    relationships: parseSemanticEntries(
      requiredData(semanticRecord, "relationships", "prepared relationship assignments"),
      "relationship", 8_192, parseRelationshipId,
    ),
  });
  const command: PreparedMutationCommand = {
    schema: 1,
    attemptId,
    base,
    intent,
    plan: parsedPlan.data,
    semanticAssignments,
  };
  freezeTree(command);
  return command;
}

export function capturePreparedPreviewInput(input: unknown): PreparedPreviewInput {
  const captured = strictRecord(captureCompleteStrictData(input), "prepared preview request");
  exactFields(captured, ["attemptId", "base", "intent", "plan"], "prepared preview request");
  const attemptId = boundedString(
    requiredData(captured, "attemptId", "prepared preview attempt id"),
    "prepared preview attempt id", 36, 36,
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId))
    throw strictInvalid("prepared preview attempt id is invalid");
  const baseRecord = strictRecord(
    requiredData(captured, "base", "prepared preview base"), "prepared preview base",
  );
  exactFields(baseRecord, ["version", "shapeSha256"], "prepared preview base");
  const base = Object.freeze({
    version: safeNonnegativeInteger(
      requiredData(baseRecord, "version", "prepared preview base version"),
      "prepared preview base version",
    ),
    shapeSha256: boundedString(
      requiredData(baseRecord, "shapeSha256", "prepared preview base digest"),
      "prepared preview base digest", 71, 71,
    ),
  });
  if (!/^sha256:[0-9a-f]{64}$/.test(base.shapeSha256))
    throw strictInvalid("prepared preview base digest is invalid");
  const intent = boundedString(
    requiredData(captured, "intent", "prepared preview intent"),
    "prepared preview intent", 1, 500,
  );
  const capturedPlan = requiredData(captured, "plan", "prepared preview plan");
  const parsedPlan = MutationPlan.safeParse(capturedPlan);
  if (!parsedPlan.success || parsedPlan.data.clarifying_question !== null)
    throw strictInvalid("prepared preview plan is invalid");
  if (stableData(capturedPlan) !== stableData(parsedPlan.data as unknown as StrictData))
    throw strictInvalid("prepared preview plan has non-canonical fields");
  const preview = { attemptId, base, intent, plan: parsedPlan.data };
  freezeTree(preview);
  return preview;
}

export type PlannerAttemptFinalization = Readonly<{
  attemptId: string;
  outcome: "clarify" | "failed" | "discarded";
  errorCode: string | null;
}>;

export function capturePlannerAttemptStart(input: unknown): Readonly<{ intent: string }> {
  const record = strictRecord(captureCompleteStrictData(input), "planner attempt start");
  exactFields(record, ["intent"], "planner attempt start");
  return Object.freeze({
    intent: boundedString(
      requiredData(record, "intent", "planner intent"), "planner intent", 1, 500,
    ),
  });
}

export function capturePlannerAttemptFinalization(input: unknown): PlannerAttemptFinalization {
  const record = strictRecord(captureCompleteStrictData(input), "planner attempt finalization");
  exactFields(record, ["attemptId", "outcome", "errorCode"], "planner attempt finalization");
  const attemptId = boundedString(
    requiredData(record, "attemptId", "planner attempt id"),
    "planner attempt id", 36, 36,
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId))
    throw strictInvalid("planner attempt id is invalid");
  const outcome = requiredData(record, "outcome", "planner attempt outcome");
  if (outcome !== "clarify" && outcome !== "failed" && outcome !== "discarded")
    throw strictInvalid("planner attempt outcome is invalid");
  const errorCodeData = requiredData(record, "errorCode", "planner attempt error code");
  const errorCode = errorCodeData === null
    ? null : boundedString(errorCodeData, "planner attempt error code", 1, 100);
  if (outcome === "failed" ? errorCode === null : errorCode !== null)
    throw strictInvalid("planner attempt error code does not match its outcome");
  return Object.freeze({ attemptId, outcome, errorCode });
}

function freezeTree(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null
      || Object.isFrozen(value)) return;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freezeTree(descriptor.value);
  }
  Object.freeze(value);
}

function semanticEntries<Id extends string>(
  source: ReadonlyMap<string, Id>,
): PreparedSemanticIdEntry<Id>[] {
  const entries: PreparedSemanticIdEntry<Id>[] = [];
  for (const [key, id] of source.entries()) entries.push({ key, id });
  entries.sort((left, right) => left.key.localeCompare(right.key));
  return entries;
}

function listedIds<Id extends string>(
  entriesToUse: readonly PreparedSemanticIdEntry<Id>[],
  expectedSize: number,
  kind: string,
): ReadonlyMap<string, Id> {
  const desired = new Map<string, Id>();
  for (const entry of entriesToUse) {
    if (desired.has(entry.key))
      throw new ClayError("E_VALIDATION", `duplicate prepared ${kind} assignment`);
    desired.set(entry.key, entry.id);
  }
  if (desired.size !== expectedSize)
    throw new ClayError("E_VALIDATION", `prepared ${kind} assignments do not match the plan`);
  return desired;
}

function exactIds<Id extends string>(
  generated: ReadonlyMap<string, Id>,
  entriesToUse: readonly PreparedSemanticIdEntry<Id>[],
  kind: string,
): ReadonlyMap<string, Id> {
  const desired = listedIds(entriesToUse, generated.size, kind);
  for (const key of generated.keys()) {
    if (!desired.has(key))
      throw new ClayError("E_VALIDATION", `prepared ${kind} assignment is missing '${key}'`);
  }
  return desired;
}

function remappedId<Id extends string>(ids: ReadonlyMap<Id, Id>, id: Id, kind: string): Id {
  const remapped = ids.get(id);
  if (!remapped)
    throw new ClayError("E_VALIDATION", `prepared ${kind} identity is incomplete`);
  return remapped;
}

function remapRelationship(
  source: SemanticRelationshipRecordV1,
  tableIds: ReadonlyMap<TableId, TableId>,
  fieldIds: ReadonlyMap<FieldId, FieldId>,
  desiredRelationships: ReadonlyMap<string, RelationshipId>,
): SemanticRelationshipRecordV1 {
  const events = source.events.map(event => ({ ...event }));
  if (source.kind === "contains") {
    const fromTableId = remappedId(tableIds, source.fromTableId, "table");
    const toFieldId = remappedId(fieldIds, source.toFieldId, "field");
    const key = `contains\u0000${fromTableId}\u0000${toFieldId}`;
    const relationshipId = desiredRelationships.get(key);
    if (!relationshipId)
      throw new ClayError("E_VALIDATION", `prepared relationship assignment is missing '${key}'`);
    return { ...source, relationshipId, fromTableId, toFieldId, events };
  }
  if (source.kind === "derived_from") {
    const fromFieldId = remappedId(fieldIds, source.fromFieldId, "field");
    const toFieldId = remappedId(fieldIds, source.toFieldId, "field");
    const key = `derived_from\u0000${fromFieldId}\u0000${toFieldId}`;
    const relationshipId = desiredRelationships.get(key);
    if (!relationshipId)
      throw new ClayError("E_VALIDATION", `prepared relationship assignment is missing '${key}'`);
    return { ...source, relationshipId, fromFieldId, toFieldId, events };
  }
  const fromTableId = remappedId(tableIds, source.fromTableId, "table");
  const toTableId = remappedId(tableIds, source.toTableId, "table");
  const viaFieldId = remappedId(fieldIds, source.viaFieldId, "field");
  const key = `references\u0000${fromTableId}\u0000${toTableId}\u0000${viaFieldId}`;
  const relationshipId = desiredRelationships.get(key);
  if (!relationshipId)
    throw new ClayError("E_VALIDATION", `prepared relationship assignment is missing '${key}'`);
  return { ...source, relationshipId, fromTableId, toTableId, viaFieldId, events };
}

/** Rebuild complete trusted semantic records from bounded prepared identities.
 * Keep re-simulates the plan; semantic records themselves never cross the boundary. */
export function materializePreparedSemanticAssignments(
  generated: PreparedSemanticAssignmentsV1,
  data: PreparedSemanticAssignmentsDataV1,
): PreparedSemanticAssignmentsV1 {
  if (data.schema !== 1 || data.version !== generated.version || data.origin !== generated.origin)
    throw new ClayError("E_VALIDATION", "prepared semantic assignments target another commit");
  const tables = exactIds(generated.tables, data.tables, "table");
  const fields = exactIds(generated.fields, data.fields, "field");
  const desiredRelationships = listedIds(
    data.relationships, generated.relationships.size, "relationship");
  const tableIds = new Map<TableId, TableId>();
  for (const [name, generatedId] of generated.tables) {
    const desired = tables.get(name);
    if (!desired) throw new ClayError("E_VALIDATION", `prepared table assignment is missing '${name}'`);
    tableIds.set(generatedId, desired);
  }
  const fieldIds = new Map<FieldId, FieldId>();
  for (const [key, generatedId] of generated.fields) {
    const desired = fields.get(key);
    if (!desired) throw new ClayError("E_VALIDATION", `prepared field assignment is missing '${key}'`);
    fieldIds.set(generatedId, desired);
  }
  const tableSemantics = new Map<string, ReturnType<typeof cloneTableSemantic>>();
  const relationships = new Map<string, RelationshipId>();
  for (const [name, source] of generated.tableSemantics) {
    const semantic = cloneTableSemantic(source);
    const tableId = tables.get(name);
    if (!tableId) throw new ClayError("E_VALIDATION", `prepared table assignment is missing '${name}'`);
    semantic.tableId = tableId;
    semantic.relationships = semantic.relationships.map(relationship => {
      const remapped = remapRelationship(relationship, tableIds, fieldIds, desiredRelationships);
      const from = remapped.kind === "derived_from" ? remapped.fromFieldId : remapped.fromTableId;
      const to = remapped.kind === "contains" ? remapped.toFieldId
        : remapped.kind === "derived_from" ? remapped.toFieldId : remapped.toTableId;
      const via = remapped.kind === "references" ? `\u0000${remapped.viaFieldId}` : "";
      relationships.set(`${remapped.kind}\u0000${from}\u0000${to}${via}`, remapped.relationshipId);
      return remapped;
    });
    tableSemantics.set(name, semantic);
  }
  if (relationships.size !== desiredRelationships.size)
    throw new ClayError("E_VALIDATION", "prepared relationship assignments do not match the plan");
  const fieldSemantics = new Map<string, ReturnType<typeof cloneFieldSemantic>>();
  for (const [key, source] of generated.fieldSemantics) {
    const semantic = cloneFieldSemantic(source);
    const fieldId = fields.get(key);
    if (!fieldId) throw new ClayError("E_VALIDATION", `prepared field assignment is missing '${key}'`);
    semantic.fieldId = fieldId;
    fieldSemantics.set(key, semantic);
  }
  return {
    v: 1,
    version: generated.version,
    origin: generated.origin,
    tables,
    fields,
    relationships,
    tableSemantics,
    fieldSemantics,
  };
}

export function buildPreparedMutationCommand(input: Readonly<{
  attemptId: string;
  base: PreparedMutationBase;
  intent: string;
  plan: MutationPlan;
  semanticAssignments: PreparedSemanticAssignmentsV1;
}>): PreparedMutationCommand {
  const command: PreparedMutationCommand = {
    schema: 1,
    attemptId: input.attemptId,
    base: {
      version: input.base.version,
      shapeSha256: input.base.shapeSha256,
    },
    intent: input.intent,
    plan: input.plan,
    semanticAssignments: {
      schema: 1,
      version: input.semanticAssignments.version,
      origin: input.semanticAssignments.origin,
      tables: semanticEntries(input.semanticAssignments.tables),
      fields: semanticEntries(input.semanticAssignments.fields),
      relationships: semanticEntries(input.semanticAssignments.relationships),
    },
  };
  freezeTree(command);
  return command;
}
