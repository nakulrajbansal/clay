import { ClayError } from "./errors";
import { deriveInverse, type ForwardOpT } from "./migrate";
import { registryToJson } from "./registry";
import { ClayStore, PRODUCTION_STORE_PRIMITIVES } from "./store";
import { RelationKeepRequest, RelationUndoRequest, keepRelation, undoRelation, type CapturedRelationKeep, type CapturedRelationUndo } from "./production-relation";
import type { DbDriver } from "./db";
import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import { captureDaily, executeDaily, type CapturedDaily } from "./production-daily";
import { ManualBackupDownloadV2 } from "@clay/schema/standalone/backup";
import { recordManualBackupDownload } from "./production-manual-backup";
import { captureJsonValue, capturedExecution, type CapturedMutationExecution } from "./production-json-capture";
import { assertExactSampleProvenance } from "./production-response-envelope";
import { captureSampleFill, captureSampleRemoval, executeCapturedSampleFill, executeCapturedSampleRemoval,
  sampleProvenanceCoordinates, type CapturedSampleFill, type SampleFillExecutionOutcome } from "./production-samples";
import { targetAuthorityInvalid as invalid } from "./production-input-capture";

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;
const PANEL_ID = /^[a-z][a-z0-9_]{2,40}$/;

type DirectColumnType =
  | "text" | "number" | "integer" | "boolean" | "date" | "enum"
  | "rich_text" | "attachment";
type CapturedDirectColumn = Readonly<{
  name: string;
  type: DirectColumnType;
  values?: readonly string[];
}>;
type CapturedRelationColumn = Readonly<{
  name: string;
  type: "relation";
  relation: Readonly<{
    target_table: string;
    cardinality: "one" | "many";
    unique_targets: boolean;
    display_field?: string;
  }>;
}>;

export type CapturedCoreMutation =
  | CapturedDaily
  | Readonly<{ requestId: string; route: "samples.fill"; payload: CapturedSampleFill }>
  | Readonly<{ requestId: string; route: "samples.remove"; payload: Readonly<Record<string, never>> }>
  | Readonly<{ requestId: string; route: "backup.manualDownload"; payload: ManualBackupDownloadV2 }>
  | Readonly<{ requestId: string; route: "schema.convertTextToRelation"; payload: CapturedRelationKeep }>
  | Readonly<{ requestId: string; route: "schema.undoRelationConversion"; payload: CapturedRelationUndo }>
  | Readonly<{ requestId: string; route: "timeline.setCheckpoint";
      payload: Readonly<{ version: number; label: string }> }>
  | Readonly<{ requestId: string; route: "timeline.makeLatest";
      payload: Readonly<{ version: number }> }>
  | Readonly<{ requestId: string; route: "panel.revert";
      payload: Readonly<{ panelId: string }> }>
  | Readonly<{ requestId: string; route: "panel.rename";
      payload: Readonly<{ panelId: string; title: string }> }>
  | Readonly<{ requestId: string; route: "panel.remove";
      payload: Readonly<{ panelId: string }> }>
  | Readonly<{ requestId: string; route: "schema.addColumn";
      payload: Readonly<{ table: string; column: CapturedDirectColumn }> }>
  | Readonly<{ requestId: string; route: "schema.renameColumn";
      payload: Readonly<{ table: string; from: string; to: string }> }>
  | Readonly<{ requestId: string; route: "schema.addRelationColumn";
      payload: Readonly<{ table: string; column: CapturedRelationColumn }> }>;

type DataRecord = Readonly<Record<string, unknown>>;

function dataRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): DataRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("expected data record");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("expected plain data record");
  const keys = Reflect.ownKeys(input);
  if (keys.length < required.length || keys.length > required.length + optional.length)
    throw new Error("unexpected record size");
  const allowed = [...required, ...optional];
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error("unexpected key");
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("expected enumerable data property");
    output[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Reflect.getOwnPropertyDescriptor(output, key)) throw new Error("missing key");
  }
  return Object.freeze(output);
}

function denseStrings(input: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(input) || Reflect.getPrototypeOf(input) !== Array.prototype)
    throw new Error("expected standard array");
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(input, "length");
  const rawLength = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value : -1;
  if (!Number.isSafeInteger(rawLength)
      || (rawLength as number) < 0 || (rawLength as number) > maxItems)
    throw new Error("invalid array length");
  const length = rawLength as number;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1 || !keys.includes("length"))
    throw new Error("array must be dense and unextended");
  const output: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
        || typeof descriptor.value !== "string"
        || descriptor.value.length > maxLength)
      throw new Error("invalid array item");
    output.push(descriptor.value);
  }
  return Object.freeze(output);
}

function directColumn(input: unknown): CapturedDirectColumn {
  const captured = dataRecord(input, ["name", "type"], ["required", "values"]);
  const name = captured.name;
  const type = captured.type;
  const requiredPresent = Reflect.getOwnPropertyDescriptor(captured, "required") !== undefined;
  const valuesPresent = Reflect.getOwnPropertyDescriptor(captured, "values") !== undefined;
  if (typeof name !== "string" || name.length > 256
      || (type !== "text" && type !== "number" && type !== "integer"
        && type !== "boolean" && type !== "date" && type !== "enum"
        && type !== "rich_text" && type !== "attachment")
      || (requiredPresent && captured.required !== false)
      || (type !== "enum" && valuesPresent)) throw new Error("invalid direct column");
  const column: { name: string; type: DirectColumnType; values?: readonly string[] } = {
    name,
    type: type as DirectColumnType,
  };
  if (valuesPresent) column.values = denseStrings(captured.values, 24, 40);
  return Object.freeze(column);
}

function relationColumn(input: unknown): CapturedRelationColumn {
  const captured = dataRecord(input, ["name", "type", "relation"], ["required"]);
  const requiredPresent = Reflect.getOwnPropertyDescriptor(captured, "required") !== undefined;
  if (typeof captured.name !== "string" || captured.name.length > 256
      || captured.type !== "relation" || (requiredPresent && captured.required !== false))
    throw new Error("invalid relation column");
  const relation = dataRecord(
    captured.relation,
    ["target_table", "cardinality"],
    ["unique_targets", "display_field"],
  );
  const uniquePresent = Reflect.getOwnPropertyDescriptor(relation, "unique_targets") !== undefined;
  const displayPresent = Reflect.getOwnPropertyDescriptor(relation, "display_field") !== undefined;
  if (typeof relation.target_table !== "string" || !IDENT.test(relation.target_table)
      || (relation.cardinality !== "one" && relation.cardinality !== "many")
      || (uniquePresent && typeof relation.unique_targets !== "boolean")
      || (displayPresent
        && (typeof relation.display_field !== "string" || !IDENT.test(relation.display_field))))
    throw new Error("invalid relation specification");
  const capturedRelation: {
    target_table: string;
    cardinality: "one" | "many";
    unique_targets: boolean;
    display_field?: string;
  } = {
    target_table: relation.target_table,
    cardinality: relation.cardinality,
    unique_targets: uniquePresent ? relation.unique_targets as boolean : false,
  };
  if (displayPresent) capturedRelation.display_field = relation.display_field as string;
  return Object.freeze({
    name: captured.name,
    type: "relation",
    relation: Object.freeze(capturedRelation),
  });
}

function panelPayload(input: unknown): Readonly<{ panelId: string }> {
  const payload = dataRecord(input, ["panelId"]);
  if (typeof payload.panelId !== "string" || !PANEL_ID.test(payload.panelId))
    throw new Error("invalid panel id");
  return Object.freeze({ panelId: payload.panelId });
}

type TransitionRoute = CapturedCoreMutation["route"];
type TransitionRequest<R extends TransitionRoute = TransitionRoute> = Extract<CapturedCoreMutation, { route: R }>;
/** Private, closed data instructions, not a worker transport. Registry-selected
 * identifiers still receive their original semantic/Store checks under authority. */
export type StoreCommand = { [R in TransitionRoute]: readonly [R, TransitionRequest<R>["payload"], string] }[TransitionRoute];
/** This closed kind declares the entire canonical mutation policy, not optional
 * metadata flags: exact selected app/generation + catalog/fence, bounded capture,
 * shadow preparation, V2 operation/fingerprint, reserve/invoke, guarded commands,
 * canonical/Merkle publication and mirrored terminal receipt/readback, in that
 * error order. No-op must write a canonical terminal receipt; replay must bind
 * the exact current result/reservation. Abandonment/poisoning stay mandatory.
 * Only clock acquisition varies here. Operational metrics cannot use this kind.
 * These obligations execute unconditionally in the coordinator; callers cannot
 * opt out by changing a descriptor's noOp/replay/canonical/target boolean. */
const canonicalPolicy = Object.freeze({
  kind: "canonical-shadow-journal-v1", native: "guarded-transaction", clock: "none",
} as const);
const timedPolicy = Object.freeze({ ...canonicalPolicy, clock: "trusted-instant" } as const);
// Same journal/fence/no-op protocol, distinct input and producer-envelope contracts.
const sampleProducerPolicy = Object.freeze({ ...canonicalPolicy, kind: "canonical-sample-producer-v1" } as const);
const sampleRemovalPolicy = Object.freeze({ ...canonicalPolicy, kind: "canonical-sample-removal-v1" } as const);
type TransitionContext = Readonly<{ requestId: string; target?: TargetEvidenceV1; driver?: DbDriver; now?: string; operationId?: string }>;
export type ProductionRouteSpec<R extends TransitionRoute = TransitionRoute> = Readonly<{
  route: R;
  policy: typeof canonicalPolicy | typeof timedPolicy | typeof sampleProducerPolicy | typeof sampleRemovalPolicy;
  capture: (requestId: string, input: unknown) => TransitionRequest<R>;
  prepare: (request: TransitionRequest<R>) => StoreCommand;
  execute: (store: ClayStore, payload: TransitionRequest<R>["payload"], context: TransitionContext) => unknown;
  result: (value: unknown) => CapturedMutationExecution;
}>;
const requests = new WeakSet<object>();
// Only schema-returned bounded plain data reaches this freezer (never caller data).
function freezeParsed<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeParsed(child);
    Object.freeze(value);
  }
  return value;
}
function spec<R extends TransitionRoute>(route: R, policy: ProductionRouteSpec["policy"],
  capture: (input: unknown, requestId: string) => TransitionRequest<R>["payload"],
  execute: ProductionRouteSpec<R>["execute"],
): ProductionRouteSpec<R> {
  return Object.freeze({ route, policy,
    capture: (requestId: string, input: unknown) => {
      // R and its exact payload are correlated by this source-private factory.
      const request = freezeParsed({ requestId, route, payload: capture(input, requestId) }) as unknown as TransitionRequest<R>;
      requests.add(request); return request;
    },
    prepare: (input: TransitionRequest<R>) => {
      if (!requests.has(input) || (input as TransitionRequest).route !== route)
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "production request is not captured");
      const request = input as TransitionRequest;
      return Object.freeze([route, request.payload, request.requestId]) as StoreCommand;
    },
    execute, result: (value: unknown) => capturedExecution(captureJsonValue(value, new WeakSet())),
  });
}
const panels = (store: ClayStore) => PRODUCTION_STORE_PRIMITIVES.livePanels.call(store);
function dailySpec<R extends CapturedDaily["route"]>(route: R): ProductionRouteSpec<R> {
  return spec(route, timedPolicy,
    (input, requestId) => captureDaily(requestId, route, input).payload as TransitionRequest<R>["payload"],
    (store, payload, context) => executeDaily(store, { requestId: context.requestId, route, payload } as CapturedDaily,
      context.target, context.driver, context.now));
}
function columnPayload<T>(input: unknown, capture: (input: unknown) => T): Readonly<{ table: string; column: T }> {
  const payload = dataRecord(input, ["table", "column"]);
  if (typeof payload.table !== "string" || !IDENT.test(payload.table)) throw new Error("invalid table");
  return Object.freeze({ table: payload.table, column: capture(payload.column) });
}
const specifications = Object.freeze(Object.fromEntries([
  Object.freeze({ ...spec("samples.fill", sampleProducerPolicy, captureSampleFill, (store, payload, { operationId }) => {
    if (!operationId) throw invalid("sample fill operation identity is unavailable");
    if (sampleProvenanceCoordinates(store, operationId).length !== 0)
      throw invalid("sample fill operation provenance already exists");
    const outcome = executeCapturedSampleFill(store, payload, operationId);
    const expected = payload.tables.reduce((total, table) => total + table.rows.length, 0);
    assertExactSampleProvenance(outcome.sampleProvenance, sampleProvenanceCoordinates(store, operationId), expected, "sample fill operation");
    return outcome;
  }), result: (value: unknown) => {
    // Only the pinned producer above returns this already checked immutable outcome.
    const outcome = value as SampleFillExecutionOutcome;
    return capturedExecution(captureJsonValue(outcome.result, new WeakSet()), outcome.sampleProvenance);
  } }),
  spec("samples.remove", sampleRemovalPolicy, captureSampleRemoval, store => executeCapturedSampleRemoval(store)),
  spec("backup.manualDownload", canonicalPolicy, input => ManualBackupDownloadV2.parse(input), (store, payload, { target, requestId }) => {
    if (!target) throw new ClayError("E_CONFLICT", "Download record requires an authority target");
    return recordManualBackupDownload(store, requestId, payload, target);
  }),
  spec("timeline.setCheckpoint", canonicalPolicy, input => {
    const payload = dataRecord(input, ["version", "label"]);
    if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 0 || typeof payload.label !== "string")
      throw new Error("invalid checkpoint");
    return Object.freeze({ version: payload.version as number, label: payload.label });
  }, (store, payload) => {
    PRODUCTION_STORE_PRIMITIVES.setCheckpoint.call(store, payload.version, payload.label);
    return PRODUCTION_STORE_PRIMITIVES.history.call(store);
  }),
  spec("timeline.makeLatest", canonicalPolicy, input => {
    const payload = dataRecord(input, ["version"]);
    if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 0) throw new Error("invalid timeline version");
    return Object.freeze({ version: payload.version as number });
  }, (store, payload) => { PRODUCTION_STORE_PRIMITIVES.rollbackTo.call(store, payload.version, { truncate: true }); return panels(store); }),
  spec("panel.revert", canonicalPolicy, panelPayload, (store, payload) => {
    PRODUCTION_STORE_PRIMITIVES.revertPanel.call(store, payload.panelId); return panels(store);
  }),
  spec("panel.remove", canonicalPolicy, panelPayload, (store, payload) => {
    PRODUCTION_STORE_PRIMITIVES.removePanel.call(store, payload.panelId); return panels(store);
  }),
  spec("panel.rename", canonicalPolicy, input => {
    const payload = dataRecord(input, ["panelId", "title"]);
    if (typeof payload.panelId !== "string" || !PANEL_ID.test(payload.panelId) || typeof payload.title !== "string")
      throw new Error("invalid panel rename");
    return Object.freeze({ panelId: payload.panelId, title: payload.title });
  }, (store, payload) => { PRODUCTION_STORE_PRIMITIVES.renamePanel.call(store, payload.panelId, payload.title); return panels(store); }),
  dailySpec("daily.source"), dailySpec("daily.navigation"), dailySpec("daily.timeZone"), dailySpec("daily.capture"),
  dailySpec("daily.undoCapture"), dailySpec("daily.inbox"), dailySpec("daily.undoInbox"),
  spec("schema.convertTextToRelation", canonicalPolicy, input => RelationKeepRequest.parse(input), (store, payload, { target }) => {
    if (!target) throw new ClayError("E_CONFLICT", "conversion requires an authority target");
    return keepRelation(store, payload, target);
  }),
  spec("schema.undoRelationConversion", canonicalPolicy, input => RelationUndoRequest.parse(input), (store, payload, { target, driver }) => {
    if (!target || !driver) throw new ClayError("E_CONFLICT", "conversion Undo requires authority");
    return undoRelation(store, driver, payload, target);
  }),
  spec("schema.addColumn", canonicalPolicy, input => columnPayload(input, directColumn),
    (store, payload) => commitColumn(store, payload.table, payload.column)),
  spec("schema.addRelationColumn", canonicalPolicy, input => columnPayload(input, relationColumn),
    (store, payload) => commitColumn(store, payload.table, payload.column)),
  spec("schema.renameColumn", canonicalPolicy, input => {
    const payload = dataRecord(input, ["table", "from", "to"]);
    if (typeof payload.table !== "string" || !IDENT.test(payload.table)
        || typeof payload.from !== "string" || !IDENT.test(payload.from)
        || typeof payload.to !== "string" || payload.to.length > 256) throw new Error("invalid column rename");
    return Object.freeze({ table: payload.table, from: payload.from, to: payload.to });
  }, (store, payload) => renameColumn(store, payload.table, payload.from, payload.to)),
].map(spec => [spec.route, spec])) as Readonly<Record<TransitionRoute, ProductionRouteSpec>>);
/** Unknown/retired routes never acquire a descriptor; prototype lookup is forbidden. */
export function productionRouteSpec(route: string): ProductionRouteSpec | null {
  return Object.hasOwn(specifications, route) ? specifications[route as TransitionRoute] : null;
}
const transitions = new WeakSet<object>();
export type ProductionTransition = Readonly<{ spec: ProductionRouteSpec; command: StoreCommand }>;
/** Pure preparation; neither Store/driver nor caller-selected instructions. */
export function prepareProductionTransition(request: CapturedCoreMutation): ProductionTransition | null {
  const route = productionRouteSpec(request.route);
  if (!route) return null;
  const transition = Object.freeze({ spec: route, command: route.prepare(request as TransitionRequest) });
  transitions.add(transition); return transition;
}
/** Called in disposable shadow or LiveWriteAuthority's synchronous transaction.
 * The original coordinator owns all capture/fence/reserve/publish/readback stages. */
export function executeProductionTransition(store: ClayStore, transition: ProductionTransition,
  target?: TargetEvidenceV1, driver?: DbDriver, now?: string, operationId?: string): CapturedMutationExecution {
  if (!transitions.has(transition)) throw new ClayError("E_TARGET_AUTHORITY_INVALID", "production transition is not captured");
  return transition.spec.result(transition.spec.execute(store, transition.command[1], {
    requestId: transition.command[2], target, driver, now, operationId,
  }));
}

/** Input has already passed descriptor-safe bounded worker capture. */
export function captureCoreMutation(requestId: string, route: string, input: unknown): CapturedCoreMutation | null {
  const spec = productionRouteSpec(route);
  return spec ? spec.capture(requestId, input) : null;
}
export function isCapturedCoreMutation(request: Readonly<{ route: string }>): request is CapturedCoreMutation {
  return productionRouteSpec(request.route) !== null;
}

function columnIdent(label: string): string {
  return label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "c$1")
    .slice(0, 40);
}

function registryResult(store: ClayStore): unknown {
  return JSON.parse(registryToJson(
    PRODUCTION_STORE_PRIMITIVES.registrySnapshot.call(store),
  ));
}

function commitColumn(
  store: ClayStore,
  table: string,
  column: CapturedDirectColumn | CapturedRelationColumn,
): unknown {
  const name = columnIdent(column.name);
  if (!IDENT.test(name))
    throw new ClayError("E_VALIDATION", `'${column.name}' is not a usable column name`);
  const operation: ForwardOpT = {
    op: "add_column",
    table,
    column: {
      name,
      type: column.type,
      required: false,
      ...(column.name.trim() !== name ? { label: column.name.trim().slice(0, 60) } : {}),
      ...(column.type === "enum" && column.values && column.values.length > 0
        ? { values: [...column.values] } : {}),
      ...(column.type === "relation" ? { relation: {
        target_table: column.relation.target_table,
        cardinality: column.relation.cardinality,
        unique_targets: column.relation.unique_targets,
        ...(column.relation.display_field === undefined
          ? {} : { display_field: column.relation.display_field }),
      } } : {}),
    },
  };
  const operations: ForwardOpT[] = [operation];
  PRODUCTION_STORE_PRIMITIVES.commit.call(store, {
    intent: `add a ${name} column to ${table}`,
    summary: `Added a “${name}” column to ${table}.`,
    semanticOrigin: "direct",
    migration: { operations, inverse: deriveInverse(
      operations, PRODUCTION_STORE_PRIMITIVES.registrySnapshot.call(store),
    ) },
    panels: [],
    diff: [{ kind: "add_field", detail: `${name} (${column.type}) on ${table}` }],
  });
  return registryResult(store);
}

function renameColumn(store: ClayStore, table: string, from: string, to: string): unknown {
  const next = columnIdent(to);
  if (!IDENT.test(next))
    throw new ClayError("E_VALIDATION", `'${to}' is not a usable column name`);
  const registry = PRODUCTION_STORE_PRIMITIVES.registrySnapshot.call(store);
  const activeTable = registry.get(table);
  if (!activeTable)
    throw new ClayError("E_VALIDATION", `no active table '${table}'`);
  if (!activeTable.columns.some(column => column.name === from && !column.inactive))
    throw new ClayError("E_VALIDATION", `no active column '${table}.${from}'`);
  if (next === from) return JSON.parse(registryToJson(registry));
  const operations: ForwardOpT[] = [{ op: "rename_column", table, from, to: next }];
  PRODUCTION_STORE_PRIMITIVES.commit.call(store, {
    intent: `rename ${table}.${from} to ${next}`,
    summary: `Renamed “${from}” to “${next}” on ${table}.`,
    semanticOrigin: "direct",
    migration: { operations, inverse: deriveInverse(
      operations, PRODUCTION_STORE_PRIMITIVES.registrySnapshot.call(store),
    ) },
    panels: [],
    diff: [{ kind: "change_field", detail: `${from} → ${next} on ${table}` }],
  });
  return registryResult(store);
}

/** Internal compatibility entrypoint; no WorkerClient command accepts a program. */
export function executeCapturedCoreMutation(store: ClayStore, request: CapturedCoreMutation,
  target?: TargetEvidenceV1, driver?: DbDriver, now?: string): unknown {
  const transition = prepareProductionTransition(request);
  if (transition) return executeProductionTransition(store, transition, target, driver, now).result;
  throw new ClayError("E_TARGET_AUTHORITY_INVALID", "production transition route is unavailable");
}
