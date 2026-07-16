// Local schema edits (ADR-027): add/rename a column as trusted-shell
// commits through the EXISTING migration vocabulary — the same ops a model
// plan would emit, with the kernel-derived inverse, on the same reversible
// timeline. No model call, no new capability surface (commitLayout
// precedent, ADR-022c).
import { ClayStore, deriveInverse, type MigrationPlanT } from "@clay/kernel";

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;

export type NewColumn = {
  name: string;
  type: "text" | "number" | "integer" | "boolean" | "date" | "enum";
  values?: string[];
};

/** Normalize a human label into a column ident ("Due date" -> due_date). */
export function toIdent(label: string): string {
  return label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "c$1")
    .slice(0, 40);
}

export function addColumnCommit(store: ClayStore, table: string, column: NewColumn): number {
  const name = toIdent(column.name);
  if (!IDENT.test(name)) throw new Error(`'${column.name}' is not a usable column name`);
  const ops: MigrationPlanT["operations"] = [{
    op: "add_column", table,
    column: { name, type: column.type, required: false,
      ...(column.type === "enum" && column.values?.length ? { values: column.values } : {}) },
  }];
  return store.commit({
    intent: `add a ${name} column to ${table}`,
    summary: `Added a “${name}” column to ${table}.`,
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
    panels: [],
    diff: [{ kind: "add_field", detail: `${name} (${column.type}) on ${table}` }],
  });
}

export function renameColumnCommit(store: ClayStore, table: string, from: string, to: string): number {
  const next = toIdent(to);
  if (!IDENT.test(next)) throw new Error(`'${to}' is not a usable column name`);
  if (next === from) return store.headVersion();
  const ops: MigrationPlanT["operations"] = [{ op: "rename_column", table, from, to: next }];
  return store.commit({
    intent: `rename ${table}.${from} to ${next}`,
    summary: `Renamed “${from}” to “${next}” on ${table}.`,
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) },
    panels: [],
    diff: [{ kind: "change_field", detail: `${from} → ${next} on ${table}` }],
  });
}
