// Schema registry: the in-memory model of tables_registry (doc 04 §3).
// The kernel consults this for every validation; SQLite's actual DDL is
// derived from it and never inspected directly.
import { ClayError } from "./errors";
import type { ExprScope, ExprType } from "./expr";

export type ColumnKind =
  | "text" | "number" | "integer" | "boolean" | "date" | "enum" | "json" | "computed";

export type RegColumn = {
  name: string;
  type: ColumnKind;
  required: boolean;
  values?: string[];   // enum only
  expr?: string;       // computed only
  hidden?: boolean;    // hide_column sets this; data retained (I3)
};

export type RegTable = { name: string; columns: RegColumn[] };
export type Registry = Map<string, RegTable>;

export const KERNEL_COLUMNS: readonly { name: string; type: ColumnKind }[] = [
  { name: "id", type: "text" },
  { name: "created_at", type: "date" },
  { name: "updated_at", type: "date" },
  { name: "deleted_at", type: "date" },
];
export const KERNEL_COLUMN_NAMES: ReadonlySet<string> =
  new Set(KERNEL_COLUMNS.map(c => c.name));

export function getTable(reg: Registry, name: string): RegTable {
  const t = reg.get(name);
  if (!t) throw new ClayError("E_TABLE_UNKNOWN", `unknown table '${name}'`);
  return t;
}

export function findColumn(t: RegTable, name: string): RegColumn | undefined {
  return t.columns.find(c => c.name === name);
}

export type ResolvedField =
  | { kind: "kernel"; type: ColumnKind }
  | { kind: "physical"; column: RegColumn }
  | { kind: "computed"; column: RegColumn };

/** Resolve a query-visible field; hidden columns are invisible (E_COLUMN_UNKNOWN). */
export function resolveField(t: RegTable, name: string): ResolvedField {
  const k = KERNEL_COLUMNS.find(c => c.name === name);
  if (k) return { kind: "kernel", type: k.type };
  const c = findColumn(t, name);
  if (!c || c.hidden)
    throw new ClayError("E_COLUMN_UNKNOWN", `unknown column '${t.name}.${name}'`);
  return c.type === "computed" ? { kind: "computed", column: c } : { kind: "physical", column: c };
}

export function physicalColumns(t: RegTable): RegColumn[] {
  return t.columns.filter(c => c.type !== "computed");
}

export function columnTypeToExprType(k: ColumnKind): ExprType | null {
  switch (k) {
    case "text": case "enum": return "text";
    case "number": case "integer": return "number";
    case "boolean": return "bool";
    case "date": return "date";
    default: return null;   // json/computed not addressable from expressions
  }
}

/**
 * The expression scope of a table: physical, non-hidden columns only.
 * Computed columns may not reference other computed columns (narrow v1
 * reading; OPEN-QUESTIONS Q16).
 */
export function exprScope(t: RegTable): ExprScope {
  const scope: ExprScope = {};
  for (const c of physicalColumns(t)) {
    if (c.hidden) continue;
    const et = columnTypeToExprType(c.type);
    if (et) scope[c.name] = et;
  }
  return scope;
}

export function cloneRegistry(reg: Registry): Registry {
  const out: Registry = new Map();
  for (const [name, t] of reg) {
    out.set(name, {
      name: t.name,
      columns: t.columns.map(c => ({ ...c, values: c.values ? [...c.values] : undefined })),
    });
  }
  return out;
}

/** Stable, comparable serialization (PB1/PB2 equality checks). */
export function registryToJson(reg: Registry): string {
  const tables = [...reg.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => ({ name: t.name, columns: t.columns }));
  return JSON.stringify(tables);
}
