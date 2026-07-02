// Row-level write validation (doc 03 §1 insert/update semantics): required
// fields, type coercion (ISO dates, numbers), enum membership, unknown keys
// rejected, computed columns never writable.
import { ClayError } from "./errors";
import type { SqlValue } from "./db";
import { KERNEL_COLUMN_NAMES, type RegColumn, type RegTable } from "./registry";

export function nowIso(): string {
  return new Date().toISOString();
}

/** uuidv7: 48-bit ms timestamp + version/variant bits + random tail. */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const t = BigInt(now);
  b[0] = Number((t >> 40n) & 0xffn);
  b[1] = Number((t >> 32n) & 0xffn);
  b[2] = Number((t >> 24n) & 0xffn);
  b[3] = Number((t >> 16n) & 0xffn);
  b[4] = Number((t >> 8n) & 0xffn);
  b[5] = Number(t & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function coerceValue(table: string, col: RegColumn, v: unknown): SqlValue {
  const bad = (want: string): never => {
    throw new ClayError("E_VALIDATION",
      `'${table}.${col.name}' expects ${want}`, { got: typeof v });
  };
  if (col.type === "computed")
    throw new ClayError("E_TYPE", `'${table}.${col.name}' is computed and cannot be written`);
  if (v === null) {
    if (col.required) throw new ClayError("E_VALIDATION",
      `'${table}.${col.name}' is required`);
    return null;
  }
  switch (col.type) {
    case "text":
      return typeof v === "string" ? v : bad("text");
    case "number": {
      const n = typeof v === "number" ? v
        : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : bad("a number");
    }
    case "integer": {
      const n = typeof v === "number" ? v
        : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      return Number.isInteger(n) ? n : bad("an integer");
    }
    case "boolean":
      return typeof v === "boolean" ? (v ? 1 : 0) : bad("a boolean");
    case "date":
      if (typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))) return v;
      return bad("an ISO date");
    case "enum":
      if (typeof v === "string" && (col.values ?? []).includes(v)) return v;
      return bad(`one of [${(col.values ?? []).join(", ")}]`);
    case "json":
      try { return JSON.stringify(v); } catch { return bad("a JSON value"); }
  }
}

type RowBinding = { cols: string[]; vals: SqlValue[] };

function checkKey(t: RegTable, key: string): RegColumn {
  if (KERNEL_COLUMN_NAMES.has(key))
    throw new ClayError("E_VALIDATION", `'${key}' is kernel-managed`);
  const col = t.columns.find(c => c.name === key);
  if (!col || col.hidden)
    throw new ClayError("E_VALIDATION", `unknown key '${t.name}.${key}'`);
  return col;
}

export function validateInsert(t: RegTable, input: Record<string, unknown>): RowBinding {
  const cols: string[] = [];
  const vals: SqlValue[] = [];
  for (const [key, v] of Object.entries(input)) {
    if (v === undefined) continue;
    const col = checkKey(t, key);
    cols.push(key);
    vals.push(coerceValue(t.name, col, v));
  }
  for (const col of t.columns) {
    if (col.type === "computed" || col.hidden || !col.required) continue;
    if (!cols.includes(col.name))
      throw new ClayError("E_VALIDATION", `'${t.name}.${col.name}' is required`);
  }
  return { cols, vals };
}

export function validatePatch(t: RegTable, patch: Record<string, unknown>): RowBinding {
  const cols: string[] = [];
  const vals: SqlValue[] = [];
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = checkKey(t, key);
    cols.push(key);
    vals.push(coerceValue(t.name, col, v));
  }
  if (cols.length === 0)
    throw new ClayError("E_VALIDATION", "empty patch");
  return { cols, vals };
}
