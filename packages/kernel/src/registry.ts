// Schema registry: the in-memory model of tables_registry (doc 04 §3).
// The kernel consults this for every validation; SQLite's actual DDL is
// derived from it and never inspected directly.
import { ClayError } from "./errors";
import type { ExprScope, ExprType } from "./expr";
import type {
  FieldSemanticV1,
  SemanticIdentityEventV1,
  SemanticRelationshipRecordV1,
  TableSemanticV1,
} from "./semantic";

export type ColumnKind =
  | "text" | "number" | "integer" | "boolean" | "date" | "enum" | "json" | "computed";

export type RegColumn = {
  name: string;
  type: ColumnKind;
  required: boolean;
  values?: string[];   // enum only
  expr?: string;       // computed only
  hidden?: boolean;    // hide_column sets this; data retained (I3)
  /** Kernel-only tombstone used by time travel. Physical values stay in
   * SQLite while the column is absent from the active app projection. */
  inactive?: boolean;
  /** Trusted-kernel identity and lineage. Never expose in public projections. */
  semantic?: FieldSemanticV1;
};

export type RegTable = {
  name: string;
  columns: RegColumn[];
  /** Kernel-only tombstone for a table created after the viewed version. */
  inactive?: boolean;
  reservedColumnNames?: string[];
  /** Trusted-kernel identity, lineage, and owned relationship records. */
  semantic?: TableSemanticV1;
};
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
  if (!t || t.inactive) throw new ClayError("E_TABLE_UNKNOWN", `unknown table '${name}'`);
  return t;
}

export function findColumn(t: RegTable, name: string): RegColumn | undefined {
  return t.columns.find(c => c.name === name && !c.inactive);
}

/** Internal migration lookup, including an inactive data-preservation tombstone. */
export function findStoredColumn(t: RegTable, name: string): RegColumn | undefined {
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
  return t.columns.filter(c => c.type !== "computed" && !c.inactive);
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

function cloneIdentityEvent(event: SemanticIdentityEventV1): SemanticIdentityEventV1 {
  return { ...event };
}

function cloneRelationship(
  relationship: SemanticRelationshipRecordV1,
): SemanticRelationshipRecordV1 {
  return {
    ...relationship,
    events: relationship.events.map(event => ({ ...event })),
  };
}

export function cloneFieldSemantic(semantic: FieldSemanticV1): FieldSemanticV1 {
  return {
    ...semantic,
    aliases: [...semantic.aliases],
    events: semantic.events.map(cloneIdentityEvent),
  };
}

export function cloneTableSemantic(semantic: TableSemanticV1): TableSemanticV1 {
  return {
    ...semantic,
    aliases: [...semantic.aliases],
    events: semantic.events.map(cloneIdentityEvent),
    relationships: semantic.relationships.map(cloneRelationship),
  };
}

function cloneStoredColumn(column: RegColumn): RegColumn {
  const cloned: RegColumn = {
    ...column,
    values: column.values ? [...column.values] : undefined,
  };
  if (column.semantic) cloned.semantic = cloneFieldSemantic(column.semantic);
  return cloned;
}

function cloneProjectedColumn(column: RegColumn): RegColumn {
  const { semantic: _semantic, ...projected } = column;
  return {
    ...projected,
    values: column.values ? [...column.values] : undefined,
  };
}

export function cloneRegistry(reg: Registry): Registry {
  const out: Registry = new Map();
  for (const [name, t] of reg) {
    const cloned: RegTable = {
      name: t.name,
      inactive: t.inactive,
      reservedColumnNames: t.reservedColumnNames ? [...t.reservedColumnNames] : undefined,
      columns: t.columns.map(cloneStoredColumn),
    };
    if (t.semantic) cloned.semantic = cloneTableSemantic(t.semantic);
    out.set(name, cloned);
  }
  return out;
}

/** Public app projection. Rollback tombstones and semantics are not schema. */
export function cloneActiveRegistry(reg: Registry): Registry {
  const out: Registry = new Map();
  for (const [name, t] of reg) {
    if (t.inactive) continue;
    out.set(name, {
      name: t.name,
      columns: t.columns
        .filter(c => !c.inactive)
        .map(cloneProjectedColumn),
    });
  }
  return out;
}

/** Stable, comparable serialization (PB1/PB2 equality checks). */
export function registryToJson(reg: Registry): string {
  const tables = [...reg.values()]
    .filter(t => !t.inactive)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => ({
      name: t.name,
      columns: t.columns.filter(c => !c.inactive).map(cloneProjectedColumn),
    }));
  return JSON.stringify(tables);
}
