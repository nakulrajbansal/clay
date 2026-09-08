import { MutationPlan } from "@clay/schema";
import { ClayError } from "./errors";
import { cloneFieldSemantic, cloneTableSemantic } from "./registry";
import { parseFieldId, parseRelationshipId, parseTableId } from "./semantic";
import { stableJson } from "./stable-json";
import {
  captureStrictJson,
  type StrictJson as StrictData,
  type StrictJsonCapturePolicy,
} from "./strict-json-capture";
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

type StrictRecord = { [key: string]: StrictData };

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHAPE_DIGEST = /^sha256:[0-9a-f]{64}$/;

function strictInvalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

const STRICT_CAPTURE_POLICY: StrictJsonCapturePolicy = [
  32, 50_000, 1_000_000, 2_000_000, 20_000, 512, 256, true, false,
  reason => {
    if (reason === 0)
      throw new ClayError("E_LIMIT", "prepared mutation command exceeds structural limits");
    if (reason === 1)
      throw new ClayError("E_LIMIT", "prepared mutation request exceeds the aggregate byte limit");
    if (reason === 2)
      throw new ClayError("E_LIMIT", "prepared mutation command exceeds string limits");
    if (reason === 3)
      throw new ClayError("E_LIMIT", "prepared command array exceeds limits");
    if (reason === 4)
      throw new ClayError("E_LIMIT", "prepared command record exceeds limits");
    const messages = [
      "prepared command contains a non-finite number",
      "prepared command contains unsupported data",
      "prepared command contains a cycle",
      "prepared command arrays must use the standard prototype",
      "prepared command arrays must be dense standard arrays",
      "prepared command arrays must contain enumerable data entries",
      "prepared command records must be plain data records",
      "prepared command fields must be enumerable data properties",
    ];
    throw strictInvalid(messages[reason - 5] ?? "prepared command is invalid");
  },
];

function captureCompleteStrictData(input: unknown): StrictData {
  const captured = captureStrictJson(input, STRICT_CAPTURE_POLICY);
  try {
    // Descriptor capture runs first, so structured clone can reject transparent
    // Proxy wrappers without giving caller accessors a chance to execute.
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
  if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(record, key)))
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

function captureAttemptId(record: StrictRecord, label: string): string {
  const attemptId = boundedString(requiredData(record, "attemptId", label), label, 36, 36);
  if (!ATTEMPT_ID.test(attemptId)) throw strictInvalid(`${label} is invalid`);
  return attemptId;
}

function capturePreparedCore(captured: StrictRecord, preview: boolean): PreparedPreviewInput {
  const attemptLabel = preview ? "prepared preview attempt id" : "prepared attempt id";
  const baseLabel = preview ? "prepared preview base" : "prepared mutation base";
  const versionLabel = preview ? "prepared preview base version" : "prepared base version";
  const digestLabel = preview ? "prepared preview base digest" : "prepared base shape digest";
  const intentLabel = preview ? "prepared preview intent" : "prepared intent";
  const planLabel = preview ? "prepared preview plan" : "prepared mutation plan";
  const attemptId = captureAttemptId(captured, attemptLabel);
  const baseRecord = strictRecord(requiredData(captured, "base", baseLabel), baseLabel);
  exactFields(baseRecord, ["version", "shapeSha256"], baseLabel);
  const base = Object.freeze({
    version: safeNonnegativeInteger(requiredData(baseRecord, "version", versionLabel), versionLabel),
    shapeSha256: boundedString(
      requiredData(baseRecord, "shapeSha256", digestLabel), digestLabel, 71, 71),
  });
  if (!SHAPE_DIGEST.test(base.shapeSha256)) throw strictInvalid(`${digestLabel} is invalid`);
  const intent = boundedString(requiredData(captured, "intent", intentLabel), intentLabel, 1, 500);
  const capturedPlan = requiredData(captured, "plan", planLabel);
  const parsedPlan = MutationPlan.safeParse(capturedPlan);
  if (!parsedPlan.success || parsedPlan.data.clarifying_question !== null)
    throw strictInvalid(`${planLabel} is invalid`);
  if (stableJson(capturedPlan) !== stableJson(parsedPlan.data))
    throw strictInvalid(`${planLabel} has non-canonical fields`);
  return { attemptId, base, intent, plan: parsedPlan.data };
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
  const { attemptId, base, intent, plan } = capturePreparedCore(captured, false);
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
    plan,
    semanticAssignments,
  };
  freezeTree(command);
  return command;
}

export function capturePreparedPreviewInput(input: unknown): PreparedPreviewInput {
  const captured = strictRecord(captureCompleteStrictData(input), "prepared preview request");
  exactFields(captured, ["attemptId", "base", "intent", "plan"], "prepared preview request");
  const preview = capturePreparedCore(captured, true);
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
  const attemptId = captureAttemptId(record, "planner attempt id");
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

function remappedIds<Id extends string>(
  generated: ReadonlyMap<string, Id>,
  desired: ReadonlyMap<string, Id>,
  kind: string,
): ReadonlyMap<Id, Id> {
  const result = new Map<Id, Id>();
  for (const [key, generatedId] of generated) {
    const desiredId = desired.get(key);
    if (!desiredId)
      throw new ClayError("E_VALIDATION", `prepared ${kind} assignment is missing '${key}'`);
    result.set(generatedId, desiredId);
  }
  return result;
}

function assignedRelationship(
  desired: ReadonlyMap<string, RelationshipId>,
  key: string,
): RelationshipId {
  const id = desired.get(key);
  if (!id)
    throw new ClayError("E_VALIDATION", `prepared relationship assignment is missing '${key}'`);
  return id;
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
    const relationshipId = assignedRelationship(desiredRelationships, key);
    return { ...source, relationshipId, fromTableId, toFieldId, events };
  }
  if (source.kind === "derived_from") {
    const fromFieldId = remappedId(fieldIds, source.fromFieldId, "field");
    const toFieldId = remappedId(fieldIds, source.toFieldId, "field");
    const key = `derived_from\u0000${fromFieldId}\u0000${toFieldId}`;
    const relationshipId = assignedRelationship(desiredRelationships, key);
    return { ...source, relationshipId, fromFieldId, toFieldId, events };
  }
  const fromTableId = remappedId(tableIds, source.fromTableId, "table");
  const toTableId = remappedId(tableIds, source.toTableId, "table");
  const viaFieldId = remappedId(fieldIds, source.viaFieldId, "field");
  const key = `references\u0000${fromTableId}\u0000${toTableId}\u0000${viaFieldId}`;
  const relationshipId = assignedRelationship(desiredRelationships, key);
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
  const tableIds = remappedIds(generated.tables, tables, "table");
  const fieldIds = remappedIds(generated.fields, fields, "field");
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
