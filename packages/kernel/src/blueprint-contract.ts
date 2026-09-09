type BlueprintRecord = Record<string, unknown>;

const COMMON = ["kind", "table", "sort", "where", "limit"] as const;
const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  table: [...COMMON, "columns", "filters", "search"],
  form: [...COMMON, "fields", "defaults", "submitLabel"],
  metrics: [...COMMON, "metrics"],
  chart: [...COMMON, "chart", "x", "y", "agg", "height"],
  board: [...COMMON, "groupBy", "stage", "item", "card"],
  flow: [...COMMON, "groupBy", "stage", "stages", "item", "card", "activity"],
  cards: [...COMMON, "item", "card"],
  timeline: [...COMMON, "label", "at", "start", "end"],
  calendar: [...COMMON, "date", "label"],
  feed: [...COMMON, "title", "meta"],
  progress: [...COMMON, "label", "value", "max"],
});

const DIRECTIVE = /^\s*\/\/#blueprint\s+(\{[\s\S]*\})\s*$/;
const MAX_BLUEPRINT_BYTES = 16 * 1024;
const MAX_BLUEPRINT_DEPTH = 32;
const MAX_BLUEPRINT_NODES = 10_000;
const MAX_BLUEPRINT_KEYS = 128;
const MAX_BLUEPRINT_ARRAY = 1_000;
const MAX_BLUEPRINT_STRING = 4_096;

function invalid(message: string): never {
  throw new Error(`blueprint: ${message}`);
}

function isRecord(value: unknown): value is BlueprintRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: BlueprintRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length > MAX_BLUEPRINT_KEYS || keys.some(key => !allowedSet.has(key)))
    invalid(`${label} has an unexpected field`);
}

function boundedJson(
  value: unknown,
  budget: { nodes: number },
  depth = 0,
): boolean {
  if (++budget.nodes > MAX_BLUEPRINT_NODES || depth > MAX_BLUEPRINT_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= MAX_BLUEPRINT_STRING;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_BLUEPRINT_ARRAY) return false;
    return value.every(item => boundedJson(item, budget, depth + 1));
  }
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_BLUEPRINT_KEYS) return false;
  return keys.every(key => key.length <= 128
    && boundedJson(value[key], budget, depth + 1));
}

function exactOptionalRecord(
  value: unknown,
  allowed: readonly string[],
  label: string,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) invalid(`${label} must be an object`);
  exactKeys(value, allowed, label);
}

function exactOptionalRecordArray(
  value: unknown,
  allowed: readonly string[],
  label: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  for (const item of value) {
    if (!isRecord(item)) invalid(`${label} entries must be objects`);
    exactKeys(item, allowed, `${label} entry`);
  }
}

export function parseClosedBlueprintDirective(code: string): BlueprintRecord | null {
  if (new TextEncoder().encode(code).byteLength > MAX_BLUEPRINT_BYTES)
    invalid("directive exceeds its byte limit");
  const match = DIRECTIVE.exec(code);
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(match[1]!); }
  catch { invalid("the directive is not valid JSON"); }
  if (!isRecord(value)) invalid("spec must be a JSON object");
  if (!boundedJson(value, { nodes: 0 })) invalid("spec exceeds structural limits");
  const kind = typeof value.kind === "string" ? value.kind : "";
  const allowed = ALLOWED_KEYS[kind];
  if (!allowed) invalid(`unknown kind '${kind}'`);
  exactKeys(value, allowed, `${kind} spec`);
  exactOptionalRecord(value.sort, ["field", "dir"], "sort");
  exactOptionalRecordArray(value.columns, ["field", "label", "format", "badge"], "columns");
  exactOptionalRecordArray(value.fields, ["name", "label", "kind", "required"], "fields");
  exactOptionalRecordArray(value.metrics, ["label", "agg", "field", "where", "format"], "metrics");
  exactOptionalRecord(value.item, ["title", "subtitle", "badge"], "item");
  exactOptionalRecord(value.card, ["title", "subtitle", "badge"], "card");
  exactOptionalRecordArray(value.stages, ["key", "label", "tone"], "stages");
  return value;
}
