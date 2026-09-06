import { ClayError } from "./errors";
import { isUuidV7 } from "./rows";
import { isTableId } from "./semantic";
import { sha256HexSync } from "./state-digest";

export type ProductionResponseJson =
  | null | boolean | number | string
  | ProductionResponseJson[]
  | { readonly [key: string]: ProductionResponseJson };

export type SampleProvenanceCoordinate = Readonly<{
  tableId: string;
  rowId: string;
}>;

export type DecodedProductionResponse =
  | Readonly<{ kind: "legacy"; result: ProductionResponseJson }>
  | Readonly<{
    kind: "envelope";
    route: string;
    result: ProductionResponseJson;
    sampleProvenance: readonly SampleProvenanceCoordinate[] | null;
  }>;

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_PROVENANCE = 10_000;
export const PRODUCTION_RESPONSE_PREFIX = "clay-response-v1:";

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

export function isSampleProducingRoute(route: string): boolean {
  return route === "starter.seed" || route === "samples.fill";
}

export function productionResponseRoutePrefix(route: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(route))
    throw invalid("production mutation response route is invalid");
  return `${PRODUCTION_RESPONSE_PREFIX}${route}\n`;
}

function canonicalValue(
  value: unknown,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): ProductionResponseJson {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES)
    throw invalid("production mutation response exceeds structural limits");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("production mutation response number is invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const result: ProductionResponseJson[] = [];
    for (let index = 0; index < value.length; index++)
      result.push(canonicalValue(value[index], depth + 1, budget));
    return Object.freeze(result) as unknown as ProductionResponseJson[];
  }
  if (typeof value !== "object") throw invalid("production mutation response value is invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw invalid("production mutation response object is invalid");
  const result = Object.create(null) as { [key: string]: ProductionResponseJson };
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor))
      throw invalid("production mutation response property is invalid");
    result[key] = canonicalValue(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

function parseCoordinates(value: unknown): readonly SampleProvenanceCoordinate[] {
  if (!Array.isArray(value) || value.length > MAX_PROVENANCE)
    throw invalid("production mutation sample evidence is invalid");
  const result: SampleProvenanceCoordinate[] = [];
  let previous: string | null = null;
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw invalid("production mutation sample evidence is invalid");
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).sort().join("\u0000") !== "rowId\u0000tableId"
        || !isTableId(entry.tableId) || !isUuidV7(entry.rowId))
      throw invalid("production mutation sample evidence is invalid");
    const coordinate = `${entry.tableId}\u0000${entry.rowId}`;
    if (previous !== null && previous >= coordinate)
      throw invalid("production mutation sample evidence is duplicated or reordered");
    previous = coordinate;
    result.push(Object.freeze({ tableId: entry.tableId, rowId: entry.rowId }));
  }
  return Object.freeze(result);
}

export function assertExactSampleProvenance(
  source: readonly SampleProvenanceCoordinate[],
  persisted: readonly SampleProvenanceCoordinate[],
  expectedCount: number,
  label: string,
): void {
  const sourceCoordinates = parseCoordinates(source);
  const persistedCoordinates = parseCoordinates(persisted);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0
      || sourceCoordinates.length !== expectedCount
      || JSON.stringify(sourceCoordinates) !== JSON.stringify(persistedCoordinates))
    throw invalid(`${label} provenance is incomplete or divergent`);
}

export function encodeProductionResponse(
  route: string,
  result: ProductionResponseJson,
  sampleProvenance?: readonly SampleProvenanceCoordinate[],
): Readonly<{ json: string; sha256: string }> {
  if (route.length < 1 || route.length > 80)
    throw invalid("production mutation response route is invalid");
  const producer = isSampleProducingRoute(route);
  if (producer !== (sampleProvenance !== undefined))
    throw invalid("production mutation sample evidence is incomplete");
  const verifiedProvenance = sampleProvenance === undefined
    ? undefined : parseCoordinates(sampleProvenance);
  const envelope = canonicalValue({
    schema: 1,
    route,
    result,
    ...(verifiedProvenance === undefined ? {} : { sampleProvenance: verifiedProvenance }),
  });
  const json = `${productionResponseRoutePrefix(route)}${JSON.stringify(envelope)}`;
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw invalid("production mutation result exceeds the durable evidence limit");
  return Object.freeze({ json, sha256: `sha256:${sha256HexSync(bytes)}` });
}

export function decodeProductionResponse(json: string): DecodedProductionResponse {
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw invalid("production mutation result exceeds the durable evidence limit");
  if (!json.startsWith(PRODUCTION_RESPONSE_PREFIX)) {
    let legacy: unknown;
    try { legacy = JSON.parse(json); }
    catch { throw invalid("production mutation result JSON is invalid"); }
    return Object.freeze({ kind: "legacy", result: canonicalValue(legacy) });
  }
  const separator = json.indexOf("\n", PRODUCTION_RESPONSE_PREFIX.length);
  if (separator < 0) throw invalid("production mutation response envelope is incomplete");
  const prefixedRoute = json.slice(PRODUCTION_RESPONSE_PREFIX.length, separator);
  if (json.slice(0, separator + 1) !== productionResponseRoutePrefix(prefixedRoute))
    throw invalid("production mutation response route is invalid");
  const body = json.slice(separator + 1);
  let raw: unknown;
  try { raw = JSON.parse(body); }
  catch { throw invalid("production mutation result JSON is invalid"); }
  const parsed = canonicalValue(raw);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object"
      || parsed.schema !== 1 || typeof parsed.route !== "string"
      || !Object.hasOwn(parsed, "result"))
    throw invalid("production mutation response envelope is incomplete");
  const producer = isSampleProducingRoute(parsed.route);
  const expectedKeys = producer
    ? "result\u0000route\u0000sampleProvenance\u0000schema"
    : "result\u0000route\u0000schema";
  if (Object.keys(parsed).sort().join("\u0000") !== expectedKeys
      || parsed.route !== prefixedRoute
      || JSON.stringify(parsed) !== body)
    throw invalid("production mutation response envelope is invalid");
  const sampleProvenance = producer ? parseCoordinates(parsed.sampleProvenance) : null;
  return Object.freeze({
    kind: "envelope",
    route: parsed.route,
    result: parsed.result!,
    sampleProvenance,
  });
}

export function decodeProductionResponseResult(
  json: string,
  expectedRoute: string,
): ProductionResponseJson {
  const decoded = decodeProductionResponse(json);
  if (decoded.kind === "legacy") return decoded.result;
  if (decoded.route !== expectedRoute)
    throw invalid("production mutation response route is invalid");
  return decoded.result;
}

export function authenticatedSampleResponse(
  json: string,
): Extract<DecodedProductionResponse, { kind: "envelope" }> | null {
  const decoded = decodeProductionResponse(json);
  if (decoded.kind !== "envelope" || !isSampleProducingRoute(decoded.route)) return null;
  return decoded;
}
