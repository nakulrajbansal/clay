import { ClayError } from "./errors";
import { deriveInverse, type ForwardOpT } from "./migrate";
import { registryToJson } from "./registry";
import { ClayStore, PRODUCTION_STORE_PRIMITIVES } from "./store";
import { RelationKeepRequest, keepRelation, type CapturedRelationKeep } from "./production-relation";
import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import { captureDaily, executeDaily, type CapturedDaily } from "./production-daily";

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
  | Readonly<{ requestId: string; route: "schema.convertTextToRelation"; payload: CapturedRelationKeep }>
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

function captured<T extends CapturedCoreMutation>(value: T): T {
  return value;
}

function panelPayload(input: unknown): Readonly<{ panelId: string }> {
  const payload = dataRecord(input, ["panelId"]);
  if (typeof payload.panelId !== "string" || !PANEL_ID.test(payload.panelId))
    throw new Error("invalid panel id");
  return Object.freeze({ panelId: payload.panelId });
}

/** Fixes the shape of a payload already descriptor-captured and bounded by the coordinator. */
export function captureCoreMutation(
  requestId: string,
  route: string,
  input: unknown,
): CapturedCoreMutation | null {
  switch (route) {
    case "daily.source":
    case "daily.navigation":
    case "daily.timeZone":
    case "daily.capture":
    case "daily.undoCapture":
      return captureDaily(requestId, route, input);
    case "schema.convertTextToRelation":
      return { requestId, route, payload: RelationKeepRequest.parse(input) };
    case "timeline.setCheckpoint": {
      const payload = dataRecord(input, ["version", "label"]);
      if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 0
          || typeof payload.label !== "string") throw new Error("invalid checkpoint");
      return captured(Object.freeze({ requestId, route, payload: Object.freeze({
        version: payload.version as number, label: payload.label,
      }) }));
    }
    case "timeline.makeLatest": {
      const payload = dataRecord(input, ["version"]);
      if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 0)
        throw new Error("invalid timeline version");
      return captured(Object.freeze({ requestId, route, payload: Object.freeze({
        version: payload.version as number,
      }) }));
    }
    case "panel.revert":
    case "panel.remove":
      return captured(Object.freeze({ requestId, route, payload: panelPayload(input) }));
    case "panel.rename": {
      const payload = dataRecord(input, ["panelId", "title"]);
      if (typeof payload.panelId !== "string" || !PANEL_ID.test(payload.panelId)
          || typeof payload.title !== "string") throw new Error("invalid panel rename");
      return captured(Object.freeze({ requestId, route, payload: Object.freeze({
        panelId: payload.panelId, title: payload.title,
      }) }));
    }
    case "schema.addColumn":
    case "schema.addRelationColumn": {
      const payload = dataRecord(input, ["table", "column"]);
      if (typeof payload.table !== "string" || !IDENT.test(payload.table))
        throw new Error("invalid table");
      if (route === "schema.addColumn") return captured(Object.freeze({
        requestId, route,
        payload: Object.freeze({ table: payload.table, column: directColumn(payload.column) }),
      }));
      return captured(Object.freeze({
        requestId, route,
        payload: Object.freeze({ table: payload.table, column: relationColumn(payload.column) }),
      }));
    }
    case "schema.renameColumn": {
      const payload = dataRecord(input, ["table", "from", "to"]);
      if (typeof payload.table !== "string" || !IDENT.test(payload.table)
          || typeof payload.from !== "string" || !IDENT.test(payload.from)
          || typeof payload.to !== "string" || payload.to.length > 256)
        throw new Error("invalid column rename");
      return captured(Object.freeze({ requestId, route, payload: Object.freeze({
        table: payload.table, from: payload.from, to: payload.to,
      }) }));
    }
    default:
      return null;
  }
}

export function isCapturedCoreMutation(
  request: Readonly<{ route: string }>,
): request is CapturedCoreMutation {
  switch (request.route) {
    case "daily.source":
    case "daily.navigation":
    case "daily.timeZone":
    case "daily.capture":
    case "daily.undoCapture":
    case "schema.convertTextToRelation":
    case "timeline.setCheckpoint":
    case "timeline.makeLatest":
    case "panel.revert":
    case "panel.rename":
    case "panel.remove":
    case "schema.addColumn":
    case "schema.renameColumn":
    case "schema.addRelationColumn":
      return true;
    default:
      return false;
  }
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

/** Trusted synchronous dispatch; called only inside the authority's outer transaction. */
export function executeCapturedCoreMutation(
  store: ClayStore,
  request: CapturedCoreMutation,
  target?: TargetEvidenceV1,
): unknown {
  switch (request.route) {
    case "daily.source":
    case "daily.navigation":
    case "daily.timeZone":
    case "daily.capture":
    case "daily.undoCapture":
      return executeDaily(store, request);
    case "schema.convertTextToRelation":
      if (!target) throw new ClayError("E_CONFLICT", "conversion requires an authority target");
      return keepRelation(store, request.payload, target);
    case "timeline.setCheckpoint":
      PRODUCTION_STORE_PRIMITIVES.setCheckpoint.call(
        store, request.payload.version, request.payload.label,
      );
      return PRODUCTION_STORE_PRIMITIVES.history.call(store);
    case "timeline.makeLatest":
      PRODUCTION_STORE_PRIMITIVES.rollbackTo.call(
        store, request.payload.version, { truncate: true },
      );
      return PRODUCTION_STORE_PRIMITIVES.livePanels.call(store);
    case "panel.revert":
      PRODUCTION_STORE_PRIMITIVES.revertPanel.call(store, request.payload.panelId);
      return PRODUCTION_STORE_PRIMITIVES.livePanels.call(store);
    case "panel.rename":
      PRODUCTION_STORE_PRIMITIVES.renamePanel.call(
        store, request.payload.panelId, request.payload.title,
      );
      return PRODUCTION_STORE_PRIMITIVES.livePanels.call(store);
    case "panel.remove":
      PRODUCTION_STORE_PRIMITIVES.removePanel.call(store, request.payload.panelId);
      return PRODUCTION_STORE_PRIMITIVES.livePanels.call(store);
    case "schema.addColumn":
    case "schema.addRelationColumn":
      return commitColumn(store, request.payload.table, request.payload.column);
    case "schema.renameColumn":
      return renameColumn(store, request.payload.table, request.payload.from, request.payload.to);
  }
}
