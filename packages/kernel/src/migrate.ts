// MigrationEngine: plan validation (invariants I1–I6, doc 04 §4, G23) and
// execution. Forward ops are non-destructive by vocabulary (I3); inverse
// ops may drop only what the mirrored forward op created (I2). All DDL is
// emitted with quoted identifiers (G26).
import type { z } from "zod";
import {
  ForwardOp as ForwardOpSchema,
  InverseOp as InverseOpSchema,
  MigrationPlan as MigrationPlanSchema,
} from "@clay/schema";
import { ClayError } from "./errors";
import type { DbDriver, SqlValue } from "./db";
import { compileExpr, evalExpr, exprFields, type ExprValue } from "./expr";
import {
  KERNEL_COLUMN_NAMES, cloneRegistry, columnTypeToExprType, exprScope,
  findColumn, getTable, physicalColumns,
  type ColumnKind, type RegColumn, type RegTable, type Registry,
} from "./registry";
import { coerceValue, nowIso, uuidv7 } from "./rows";

export type ForwardOpT = z.infer<typeof ForwardOpSchema>;
export type InverseOpT = z.infer<typeof InverseOpSchema>;
export type MigrationPlanT = z.infer<typeof MigrationPlanSchema>;

const SQL_TYPE: Record<Exclude<ColumnKind, "computed">, string> = {
  text: "TEXT", number: "REAL", integer: "INTEGER", boolean: "INTEGER",
  date: "TEXT", enum: "TEXT", json: "TEXT",
};

const qid = (name: string): string => `"${name}"`;
const indexName = (table: string, column: string): string => `idx_${table}_${column}`;

/** Kernel-owned user.db tables user migrations may not claim (G6). */
const RESERVED_TABLES = new Set(["row_history", "sqlite_sequence"]);

function fail(msg: string, detail?: unknown): never {
  throw new ClayError("E_VALIDATION", msg, detail);
}

function specColumnToReg(c: {
  name: string; type: ColumnKind; required?: boolean;
  values?: string[]; expr?: string;
}): RegColumn {
  const col: RegColumn = { name: c.name, type: c.type, required: c.required ?? false };
  if (c.values) col.values = [...c.values];
  if (c.expr !== undefined) col.expr = c.expr;
  return col;
}

function checkNewColumnName(t: RegTable, name: string): void {
  if (KERNEL_COLUMN_NAMES.has(name)) fail(`'${name}' is a kernel column name`);
  if (findColumn(t, name)) fail(`column '${t.name}.${name}' already exists`);
}

function checkComputedExpr(t: RegTable, expr: string): void {
  compileExpr(expr, exprScope(t));   // throws E_EXPR on any problem
}

/**
 * Simulate a forward op list against a registry copy, checking structural
 * validity of every op in sequence (V5) and expressions (I6), and return
 * the normalized mirror list (G23: backfill/add_index on plan-created
 * columns are absorbed) plus the post-migration registry. Throws ClayError
 * on the first invalid op.
 */
function computeMirrors(operations: ForwardOpT[], registry: Registry): {
  mirrors: InverseOpT[]; sim: Registry;
} {
  const sim = cloneRegistry(registry);
  const createdTables = new Set<string>();
  const createdColumns = new Set<string>();   // "table.column"
  const mirrors: InverseOpT[] = [];

  for (const op of operations) {
    switch (op.op) {
      case "create_table": {
        if (RESERVED_TABLES.has(op.table))
          fail(`'${op.table}' is a reserved table name`);
        if (sim.has(op.table)) fail(`table '${op.table}' already exists`);
        const names = new Set<string>();
        for (const c of op.columns) {
          if (KERNEL_COLUMN_NAMES.has(c.name)) fail(`'${c.name}' is a kernel column name`);
          if (names.has(c.name)) fail(`duplicate column '${c.name}'`);
          names.add(c.name);
        }
        const table: RegTable = {
          name: op.table,
          columns: op.columns.map(c => specColumnToReg(c as Parameters<typeof specColumnToReg>[0])),
        };
        sim.set(op.table, table);
        for (const c of table.columns) {
          if (c.type === "computed") checkComputedExpr(table, c.expr ?? "");
          createdColumns.add(`${op.table}.${c.name}`);
        }
        createdTables.add(op.table);
        mirrors.push({ op: "drop_table_if_created_by_this", table: op.table });
        break;
      }
      case "add_column": {
        const t = getTable(sim, op.table);
        checkNewColumnName(t, op.column.name);
        const col = specColumnToReg(op.column as Parameters<typeof specColumnToReg>[0]);
        if (col.type === "computed") checkComputedExpr(t, col.expr ?? "");
        t.columns.push(col);
        createdColumns.add(`${op.table}.${col.name}`);
        mirrors.push({ op: "drop_column_if_added_by_this", table: op.table, column: col.name });
        break;
      }
      case "rename_column": {
        const t = getTable(sim, op.table);
        const col = findColumn(t, op.from);
        if (!col) fail(`unknown column '${op.table}.${op.from}'`);
        checkNewColumnName(t, op.to);
        for (const c of t.columns)
          if (c.type === "computed" && c.expr && exprFields(compileExpr(c.expr, exprScope(t)).ast).has(op.from))
            fail(`cannot rename '${op.from}': computed column '${c.name}' references it (Q15)`);
        col.name = op.to;
        if (createdColumns.delete(`${op.table}.${op.from}`))
          createdColumns.add(`${op.table}.${op.to}`);
        mirrors.push({ op: "rename_column", table: op.table, from: op.to, to: op.from });
        break;
      }
      case "add_enum_value": {
        const t = getTable(sim, op.table);
        const col = findColumn(t, op.column);
        if (!col || col.type !== "enum") fail(`'${op.table}.${op.column}' is not an enum`);
        if ((col.values ?? []).includes(op.value)) fail(`enum value '${op.value}' already present`);
        col.values = [...(col.values ?? []), op.value];
        mirrors.push({ op: "remove_enum_value_if_unused", table: op.table, column: op.column, value: op.value });
        break;
      }
      case "add_index": {
        const t = getTable(sim, op.table);
        const col = findColumn(t, op.column);
        if (!col || col.type === "computed") fail(`'${op.table}.${op.column}' is not a physical column`);
        if (!createdColumns.has(`${op.table}.${op.column}`))
          mirrors.push({ op: "drop_index", table: op.table, column: op.column });
        break;   // absorbed when the column is plan-created (G23)
      }
      case "backfill": {
        const t = getTable(sim, op.table);
        const col = findColumn(t, op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        if (col.type === "computed") fail("cannot backfill a computed column");
        if (!createdColumns.has(`${op.table}.${op.column}`))
          fail(`backfill may only target a column created in this plan (G23)`);
        if (op.expr !== undefined) {
          const { type } = compileExpr(op.expr, exprScope(t));
          const want = columnTypeToExprType(col.type);
          if (want && type !== want)
            throw new ClayError("E_TYPE", `backfill expr yields ${type}, column is ${col.type}`);
        } else {
          coerceValue(op.table, col, op.value);
        }
        break;   // always absorbed by the column's create/drop pair (G23)
      }
      case "create_computed": {
        const t = getTable(sim, op.table);
        checkNewColumnName(t, op.column);
        checkComputedExpr(t, op.expr);
        t.columns.push({ name: op.column, type: "computed", required: false, expr: op.expr });
        createdColumns.add(`${op.table}.${op.column}`);
        mirrors.push({ op: "drop_column_if_added_by_this", table: op.table, column: op.column });
        break;
      }
      case "update_computed": {
        const t = getTable(sim, op.table);
        const col = findColumn(t, op.column);
        if (!col || col.type !== "computed") fail(`'${op.table}.${op.column}' is not computed`);
        checkComputedExpr(t, op.expr);
        mirrors.push({ op: "restore_expr", table: op.table, column: op.column, expr: col.expr ?? "" });
        col.expr = op.expr;
        break;
      }
      case "hide_column": {
        const t = getTable(sim, op.table);
        const col = findColumn(t, op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        if (col.hidden) fail(`'${op.table}.${op.column}' is already hidden`);
        col.hidden = true;
        mirrors.push({ op: "unhide_column", table: op.table, column: op.column });
        break;
      }
      case "set_required": {
        const t = getTable(sim, op.table);
        const col = findColumn(t, op.column);
        if (!col || col.type === "computed") fail(`'${op.table}.${op.column}' is not a physical column`);
        // Narrow v1 (OPEN-QUESTIONS Q17): only false->true is expressible,
        // so unset_required is a faithful inverse.
        if (op.required !== true) fail("set_required supports required:true only in v1 (Q17)");
        if (col.required) fail(`'${op.table}.${op.column}' is already required`);
        if (op.default_for_existing !== undefined)
          coerceValue(op.table, col, op.default_for_existing);
        col.required = true;
        mirrors.push({ op: "unset_required", table: op.table, column: op.column });
        break;
      }
    }
  }

  return { mirrors, sim };
}

/**
 * Validate a full MigrationPlan against a registry: op-sequence validity
 * (V5, I6 via computeMirrors) plus the I2 mirror check — the plan's inverse
 * must equal the normalized forward mirrors, reversed. Throws ClayError.
 * Returns the post-migration registry (used by the Validator to check
 * panel queries against the schema the plan produces).
 */
export function validateMigrationPlan(plan: MigrationPlanT, registry: Registry): Registry {
  const parsed = MigrationPlanSchema.safeParse(plan);
  if (!parsed.success) fail("malformed migration plan", parsed.error.issues);

  const { mirrors, sim } = computeMirrors(plan.operations, registry);
  const expected = mirrors.reverse();
  if (plan.inverse.length !== expected.length)
    fail(`I2: inverse has ${plan.inverse.length} ops, expected ${expected.length}`, { expected });
  for (let i = 0; i < expected.length; i++) {
    const got = JSON.stringify(plan.inverse[i]);
    const want = JSON.stringify(expected[i]);
    if (got !== want) fail(`I2: inverse op ${i} mismatch`, { got: plan.inverse[i], want: expected[i] });
  }
  return sim;
}

/** The canonical inverse for a forward op list (tests, kernel-local commits). */
export function deriveInverse(operations: ForwardOpT[], registry: Registry): InverseOpT[] {
  return computeMirrors(operations, registry).mirrors.reverse();
}

// ---------- execution ----------

function createTableSql(t: RegTable): string {
  const cols = [
    `"id" TEXT PRIMARY KEY`, `"created_at" TEXT NOT NULL`,
    `"updated_at" TEXT NOT NULL`, `"deleted_at" TEXT`,
  ];
  for (const c of physicalColumns(t)) cols.push(`${qid(c.name)} ${SQL_TYPE[c.type as Exclude<ColumnKind, "computed">]}`);
  return `CREATE TABLE ${qid(t.name)} (${cols.join(", ")})`;
}

function execBackfill(driver: DbDriver, reg: Registry, op: Extract<ForwardOpT, { op: "backfill" }>): void {
  const t = getTable(reg, op.table);
  const col = findColumn(t, op.column);
  if (!col) fail(`unknown column '${op.table}.${op.column}'`);
  if (op.expr !== undefined) {
    const scope = exprScope(t);
    const { ast } = compileExpr(op.expr, scope);
    const deps = [...exprFields(ast)];
    const boolDeps = new Set(deps.filter(d => findColumn(t, d)?.type === "boolean"));
    const rows = driver.select(
      `SELECT "id"${deps.length ? ", " + deps.map(qid).join(", ") : ""} FROM ${qid(op.table)}`);
    for (const row of rows) {
      const scopeRow: Record<string, ExprValue> = {};
      for (const d of deps)
        scopeRow[d] = boolDeps.has(d) && row[d] !== null ? row[d] === 1 : (row[d] ?? null);
      const v = evalExpr(ast, scopeRow);
      const bound: SqlValue = typeof v === "boolean" ? (v ? 1 : 0) : v;
      driver.exec(`UPDATE ${qid(op.table)} SET ${qid(op.column)} = ? WHERE "id" = ?`,
        [bound, row.id ?? null]);
    }
  } else {
    driver.exec(`UPDATE ${qid(op.table)} SET ${qid(op.column)} = ?`,
      [coerceValue(op.table, col, op.value)]);
  }
}

/** Execute validated forward ops; mutates `reg` alongside the SQL. */
export function applyForwardOps(driver: DbDriver, reg: Registry, ops: ForwardOpT[]): void {
  for (const op of ops) {
    switch (op.op) {
      case "create_table": {
        const table: RegTable = {
          name: op.table,
          columns: op.columns.map(c => specColumnToReg(c as Parameters<typeof specColumnToReg>[0])),
        };
        driver.exec(createTableSql(table));
        reg.set(op.table, table);
        break;
      }
      case "add_column": {
        const t = getTable(reg, op.table);
        const col = specColumnToReg(op.column as Parameters<typeof specColumnToReg>[0]);
        if (col.type !== "computed")
          driver.exec(`ALTER TABLE ${qid(op.table)} ADD COLUMN ${qid(col.name)} ${SQL_TYPE[col.type as Exclude<ColumnKind, "computed">]}`);
        t.columns.push(col);
        break;
      }
      case "rename_column": {
        const t = getTable(reg, op.table);
        const col = findColumn(t, op.from);
        if (!col) fail(`unknown column '${op.table}.${op.from}'`);
        if (col.type !== "computed")
          driver.exec(`ALTER TABLE ${qid(op.table)} RENAME COLUMN ${qid(op.from)} TO ${qid(op.to)}`);
        col.name = op.to;
        break;
      }
      case "add_enum_value": {
        const t = getTable(reg, op.table);
        const col = findColumn(t, op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        col.values = [...(col.values ?? []), op.value];
        break;   // registry-only: enum membership is kernel-validated (Q14)
      }
      case "add_index":
        driver.exec(`CREATE INDEX IF NOT EXISTS ${qid(indexName(op.table, op.column))} ON ${qid(op.table)}(${qid(op.column)})`);
        break;
      case "backfill":
        execBackfill(driver, reg, op);
        break;
      case "create_computed": {
        const t = getTable(reg, op.table);
        t.columns.push({ name: op.column, type: "computed", required: false, expr: op.expr });
        break;
      }
      case "update_computed": {
        const col = findColumn(getTable(reg, op.table), op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        col.expr = op.expr;
        break;
      }
      case "hide_column": {
        const col = findColumn(getTable(reg, op.table), op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        col.hidden = true;
        break;
      }
      case "set_required": {
        const t = getTable(reg, op.table);
        const col = findColumn(t, op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        if (op.default_for_existing !== undefined) {
          // G23: the fill is only partially invertible via the version log,
          // so the touched rows are recorded to row_history (G6).
          const nulls = driver.select(
            `SELECT * FROM ${qid(op.table)} WHERE ${qid(op.column)} IS NULL`);
          for (const row of nulls) {
            driver.exec(
              `INSERT INTO "row_history"("id", "table", "row_id", "at", "before_json")
               VALUES (?, ?, ?, ?, ?)`,
              [uuidv7(), op.table, String(row.id), nowIso(), JSON.stringify(row)]);
          }
          driver.exec(`UPDATE ${qid(op.table)} SET ${qid(op.column)} = ? WHERE ${qid(op.column)} IS NULL`,
            [coerceValue(op.table, col, op.default_for_existing)]);
        }
        col.required = true;
        break;
      }
    }
  }
}

/** Execute inverse ops in the order stored (already reversed at plan time). */
export function applyInverseOps(driver: DbDriver, reg: Registry, ops: InverseOpT[]): void {
  for (const op of ops) {
    switch (op.op) {
      case "drop_table_if_created_by_this":
        driver.exec(`DROP TABLE IF EXISTS ${qid(op.table)}`);
        reg.delete(op.table);
        break;
      case "drop_column_if_added_by_this": {
        const t = getTable(reg, op.table);
        const col = findColumn(t, op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        if (col.type !== "computed") {
          driver.exec(`DROP INDEX IF EXISTS ${qid(indexName(op.table, op.column))}`);
          driver.exec(`ALTER TABLE ${qid(op.table)} DROP COLUMN ${qid(op.column)}`);
        }
        t.columns = t.columns.filter(c => c.name !== op.column);
        break;
      }
      case "remove_enum_value_if_unused": {
        const t = getTable(reg, op.table);
        const col = findColumn(t, op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        const used = driver.select(
          `SELECT COUNT(*) AS n FROM ${qid(op.table)} WHERE ${qid(op.column)} = ?`, [op.value]);
        if ((used[0]?.n ?? 0) === 0)
          col.values = (col.values ?? []).filter(v => v !== op.value);
        break;
      }
      case "unhide_column": {
        const col = findColumn(getTable(reg, op.table), op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        delete col.hidden;   // restore the exact pre-hide registry shape
        break;
      }
      case "drop_index":
        driver.exec(`DROP INDEX IF EXISTS ${qid(indexName(op.table, op.column))}`);
        break;
      case "restore_expr": {
        const col = findColumn(getTable(reg, op.table), op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        col.expr = op.expr;
        break;
      }
      case "unset_required": {
        const col = findColumn(getTable(reg, op.table), op.column);
        if (!col) fail(`unknown column '${op.table}.${op.column}'`);
        col.required = false;
        break;
      }
      case "rename_column": {
        const t = getTable(reg, op.table);
        const col = findColumn(t, op.from);
        if (!col) fail(`unknown column '${op.table}.${op.from}'`);
        if (col.type !== "computed")
          driver.exec(`ALTER TABLE ${qid(op.table)} RENAME COLUMN ${qid(op.from)} TO ${qid(op.to)}`);
        col.name = op.to;
        break;
      }
    }
  }
}
