// QueryCompiler: Query object -> parameterized SQL (doc 03 §1, ADR-003).
// Field names are validated against the registry BEFORE any SQL assembly
// (PB3); values only ever travel as bind parameters. Computed columns have
// no physical form (doc 04 §2): they are evaluated post-SQL and projected;
// conditions/ordering on them run post-SQL too. Computed fields inside
// groupBy/aggregate are rejected in v1 (OPEN-QUESTIONS Q16).
import { Query as QuerySchema } from "@clay/schema";
import { ClayError } from "./errors";
import type { DbDriver, SqlValue } from "./db";
import {
  type Registry, type RegColumn, type RegTable, type ColumnKind,
  getTable, resolveField, physicalColumns, exprScope, findColumn,
} from "./registry";
import {
  compileExpr, evalExpr, exprFields,
  type ExprAst, type ExprValue,
} from "./expr";

export type QueryValue =
  | ExprValue | QueryValue[] | { [key: string]: QueryValue };
export type QueryRow = Record<string, QueryValue>;
export type RecordLink = { id: string; label: string; table: string };
type QueryT = import("@clay/schema").Query;
type ConditionT = NonNullable<QueryT["where"]>[number];

const DEFAULT_LIMIT = 500;
const HARD_CAP = 5000;

const qid = (name: string): string => `"${name}"`;

type CompiledComputed =
  | { kind: "expression"; name: string; ast: ExprAst; deps: Set<string> }
  | { kind: "connected"; name: string; column: RegColumn; deps: Set<string> };

export type CompiledQuery = {
  sql: string;
  params: SqlValue[];
  table: string;
  /** computed columns to project after SQL */
  computed: CompiledComputed[];
  /** conditions referencing computed columns, applied post-SQL */
  postWhere: ConditionT[];
  /** or-groups applied post-SQL (only when any group touches computed) */
  postOrWhere: ConditionT[][] | null;
  /** ordering applied post-SQL (only when it touches computed) */
  postOrder: { field: string; dir: "asc" | "desc" }[] | null;
  /** the caller-visible projection, in order */
  finalSelect: string[];
  limit: number;
  /** true when the LIMIT must be applied after post-filtering */
  postLimit: boolean;
  boolCols: Set<string>;
  jsonCols: Set<string>;
  relationDisplays: RegColumn[];
};

function fieldKind(t: RegTable, name: string): { computed: boolean; type: ColumnKind } {
  const r = resolveField(t, name);
  if (r.kind === "kernel") return { computed: false, type: r.type };
  return { computed: r.kind === "computed", type: r.column.type };
}

function effectiveFieldType(registry: Registry, table: RegTable, name: string): ColumnKind {
  const resolved = resolveField(table, name);
  if (resolved.kind === "kernel") return resolved.type;
  const column = resolved.column;
  if (column.type === "lookup" && column.lookup) {
    const relation = findColumn(table, column.lookup.relation_field);
    if (!relation?.relation) return "lookup";
    const target = getTable(registry, relation.relation.target_table);
    return findColumn(target, column.lookup.target_field)?.type ?? "lookup";
  }
  if (column.type === "rollup" && column.rollup) {
    if (["count", "sum", "avg"].includes(column.rollup.operation)) return "number";
    const relation = findColumn(table, column.rollup.relation_field);
    if (!relation?.relation || !column.rollup.target_field) return "rollup";
    return findColumn(getTable(registry, relation.relation.target_table),
      column.rollup.target_field)?.type ?? "rollup";
  }
  return column.type;
}

function conditionNeedsPost(t: RegTable, condition: ConditionT): boolean {
  const field = fieldKind(t, condition.field);
  return field.computed || (field.type === "relation" && condition.op === "contains");
}

function orderNeedsPost(t: RegTable, field: string): boolean {
  const kind = fieldKind(t, field);
  return kind.computed || kind.type === "relation";
}

function checkValueType(registry: Registry, t: RegTable, cond: ConditionT): void {
  const v = cond.value;
  if (typeof v === "object" && v !== null && !Array.isArray(v))
    throw new ClayError("E_VALIDATION",
      "placeholder {$var} is only legal in declared_queries, not executable queries");
  const type = effectiveFieldType(registry, t, cond.field);
  const need = (ok: boolean, want: string): void => {
    if (!ok) throw new ClayError("E_TYPE",
      `op '${cond.op}' on '${cond.field}' (${type}) needs ${want}`);
  };
  switch (cond.op) {
    case "is_null": case "not_null":
      need(v === undefined, "no value"); return;
    case "within_days": case "older_than_days":
      need(type === "date" || type === "computed", "a date column");
      need(typeof v === "number" && v >= 0, "a non-negative number of days");
      return;
    case "contains":
      need(type === "text" || type === "enum" || type === "rich_text"
        || type === "lookup" || type === "relation", "a text or linked column");
      need(typeof v === "string", "a text value");
      return;
    case "in":
      need(Array.isArray(v), "an array");
      return;
    case "gt": case "gte": case "lt": case "lte":
      need(v !== undefined && !Array.isArray(v), "a scalar value");
      return;
    case "eq": case "neq":
      need(v !== undefined && !Array.isArray(v), "a scalar value");
      return;
  }
}

function localStartOfDayIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
function plusDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

function bindScalar(v: string | number | boolean, type: ColumnKind): SqlValue {
  if (typeof v === "boolean") {
    if (type !== "boolean") throw new ClayError("E_TYPE", "boolean value on non-boolean column");
    return v ? 1 : 0;
  }
  return v;
}

const LIKE_SPECIALS = /[\\%_]/g;

function condToSql(registry: Registry, t: RegTable, cond: ConditionT,
  now: Date, params: SqlValue[]): string {
  checkValueType(registry, t, cond);
  const f = qid(cond.field);
  const { type } = fieldKind(t, cond.field);
  const v = cond.value;
  switch (cond.op) {
    case "eq": params.push(bindScalar(v as string | number | boolean, type)); return `${f} = ?`;
    case "neq": params.push(bindScalar(v as string | number | boolean, type)); return `${f} != ?`;
    case "gt": params.push(bindScalar(v as string | number | boolean, type)); return `${f} > ?`;
    case "gte": params.push(bindScalar(v as string | number | boolean, type)); return `${f} >= ?`;
    case "lt": params.push(bindScalar(v as string | number | boolean, type)); return `${f} < ?`;
    case "lte": params.push(bindScalar(v as string | number | boolean, type)); return `${f} <= ?`;
    case "contains": {
      const escaped = (v as string).replace(LIKE_SPECIALS, m => `\\${m}`);
      params.push(`%${escaped}%`);
      return `${f} LIKE ? ESCAPE '\\'`;
    }
    case "in": {
      const arr = v as (string | number)[];
      if (arr.length === 0) return "1 = 0";
      for (const item of arr) params.push(item);
      return `${f} IN (${arr.map(() => "?").join(", ")})`;
    }
    case "is_null": return `${f} IS NULL`;
    case "not_null": return `${f} IS NOT NULL`;
    case "within_days": {
      const lower = localStartOfDayIso(now);
      params.push(lower, plusDaysIso(lower, (v as number) + 1));
      return `(${f} >= ? AND ${f} < ?)`;
    }
    case "older_than_days": {
      params.push(plusDaysIso(localStartOfDayIso(now), -(v as number)));
      return `(${f} < ? AND ${f} IS NOT NULL)`;
    }
  }
}

export function compileQuery(reg: Registry, input: QueryT, now: Date): CompiledQuery {
  const rawLimit = (input as { limit?: unknown }).limit;
  if (typeof rawLimit === "number" && rawLimit > HARD_CAP)
    throw new ClayError("E_LIMIT", `limit ${rawLimit} exceeds hard cap ${HARD_CAP}`);
  const parsed = QuerySchema.safeParse(input);
  if (!parsed.success)
    throw new ClayError("E_VALIDATION", "malformed query", parsed.error.issues);
  const q = parsed.data;
  const t = getTable(reg, q.from);

  const limit = q.limit ?? DEFAULT_LIMIT;
  if (limit > HARD_CAP)
    throw new ClayError("E_LIMIT", `limit ${limit} exceeds hard cap ${HARD_CAP}`);

  // ---- aggregate/groupBy queries: physical fields only, pure SQL ----
  if (q.aggregate?.length || q.groupBy?.length) {
    const groupBy = q.groupBy ?? [];
    const aggregates = q.aggregate ?? [];
    for (const g of groupBy) {
      const kind = fieldKind(t, g);
      if (kind.computed || kind.type === "relation")
        throw new ClayError("E_TYPE", `computed or relation column '${g}' not allowed in groupBy (v1)`);
    }
    for (const a of aggregates) {
      const kind = fieldKind(t, a.field);
      if (kind.computed || kind.type === "relation")
        throw new ClayError("E_TYPE", `computed or relation column '${a.field}' not allowed in aggregate (v1)`);
    }
    const params: SqlValue[] = [];
    const conds: string[] = [];
    if (!q.includeDeleted) conds.push(`"deleted_at" IS NULL`);
    for (const c of q.where ?? []) {
      if (conditionNeedsPost(t, c))
        throw new ClayError("E_TYPE", `virtual or display-linked column '${c.field}' not allowed in aggregate where (v1)`);
      conds.push(condToSql(reg, t, c, now, params));
    }
    if (q.orWhere?.length) {
      const groups = q.orWhere.map(g => {
        for (const c of g)
          if (conditionNeedsPost(t, c))
            throw new ClayError("E_TYPE", "virtual or display-linked column not allowed in aggregate orWhere (v1)");
        return `(${g.map(c => condToSql(reg, t, c, now, params)).join(" AND ")})`;
      });
      conds.push(`(${groups.join(" OR ")})`);
    }
    const aliases = new Set<string>(groupBy);
    const selectParts = groupBy.map(qid);
    for (const a of aggregates) {
      aliases.add(a.as);
      selectParts.push(`${a.fn.toUpperCase()}(${qid(a.field)}) AS ${qid(a.as)}`);
    }
    const orderBy = (q.orderBy ?? []).map(o => {
      if (!aliases.has(o.field))
        throw new ClayError("E_COLUMN_UNKNOWN",
          `orderBy '${o.field}' must be a groupBy field or aggregate alias`);
      return `${qid(o.field)} ${o.dir.toUpperCase()}`;
    });
    let sql = `SELECT ${selectParts.join(", ")} FROM ${qid(q.from)}`;
    if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
    if (groupBy.length) sql += ` GROUP BY ${groupBy.map(qid).join(", ")}`;
    if (orderBy.length) sql += ` ORDER BY ${orderBy.join(", ")}`;
    sql += ` LIMIT ${limit}`;
    return {
      sql, params, table: q.from, computed: [], postWhere: [], postOrWhere: null,
      postOrder: null, finalSelect: [...aliases], limit, postLimit: false,
      boolCols: new Set(), jsonCols: new Set(), relationDisplays: [],
    };
  }

  // ---- row queries ----
  const defaultSelect = (): string[] => {
    const cols = ["id", "created_at", "updated_at"];
    if (q.includeDeleted) cols.push("deleted_at");
    for (const c of t.columns) if (!c.hidden && !c.inactive) cols.push(c.name);
    return cols;
  };
  const finalSelect = q.select ?? defaultSelect();

  const scope = exprScope(t);
  const computedByName = new Map<string, CompiledComputed>();
  const wantComputed = (name: string): CompiledComputed => {
    let cc = computedByName.get(name);
    if (!cc) {
      const resolved = resolveField(t, name);
      if (resolved.kind !== "computed") throw new ClayError("E_INTERNAL", "not virtual");
      const column = resolved.column;
      if (column.type === "computed") {
        const { ast } = compileExpr(column.expr ?? "", scope);
        cc = { kind: "expression", name, ast, deps: exprFields(ast) };
      } else {
        const relationField = column.lookup?.relation_field ?? column.rollup?.relation_field;
        if (!relationField) throw new ClayError("E_INTERNAL", "connected field has no relation");
        cc = { kind: "connected", name, column, deps: new Set([relationField]) };
      }
      computedByName.set(name, cc);
    }
    return cc;
  };

  const physNeeded = new Set<string>(["id"]);
  for (const name of finalSelect) {
    const fk = fieldKind(t, name);
    if (fk.computed) for (const d of wantComputed(name).deps) physNeeded.add(d);
    else physNeeded.add(name);
  }

  const params: SqlValue[] = [];
  const sqlConds: string[] = [];
  const postWhere: ConditionT[] = [];
  if (!q.includeDeleted) sqlConds.push(`"deleted_at" IS NULL`);
  for (const c of q.where ?? []) {
    checkValueType(reg, t, c);
    if (conditionNeedsPost(t, c)) {
      if (fieldKind(t, c.field).computed)
        for (const d of wantComputed(c.field).deps) physNeeded.add(d);
      else physNeeded.add(c.field);
      postWhere.push(c);
    } else sqlConds.push(condToSql(reg, t, c, now, params));
  }

  let postOrWhere: ConditionT[][] | null = null;
  if (q.orWhere?.length) {
    const touchesPost = q.orWhere.some(group =>
      group.some(condition => conditionNeedsPost(t, condition)));
    if (touchesPost) {
      for (const g of q.orWhere) for (const c of g) {
        checkValueType(reg, t, c);
        if (fieldKind(t, c.field).computed)
          for (const d of wantComputed(c.field).deps) physNeeded.add(d);
        else physNeeded.add(c.field);
      }
      postOrWhere = q.orWhere;
    } else {
      const groups = q.orWhere.map(g =>
        `(${g.map(c => condToSql(reg, t, c, now, params)).join(" AND ")})`);
      sqlConds.push(`(${groups.join(" OR ")})`);
    }
  }

  let sqlOrder: string[] = [];
  let postOrder: { field: string; dir: "asc" | "desc" }[] | null = null;
  if (q.orderBy?.length) {
    const touchesPost = q.orderBy.some(order => orderNeedsPost(t, order.field));
    if (touchesPost) {
      for (const o of q.orderBy) {
        if (fieldKind(t, o.field).computed)
          for (const d of wantComputed(o.field).deps) physNeeded.add(d);
        else physNeeded.add(o.field);
      }
      postOrder = q.orderBy;
    } else {
      sqlOrder = q.orderBy.map(o => {
        fieldKind(t, o.field);
        return `${qid(o.field)} ${o.dir.toUpperCase()}`;
      });
    }
  }
  // post conditions on virtual fields may also order/filter on them
  for (const c of postWhere)
    if (fieldKind(t, c.field).computed) void wantComputed(c.field);

  const postLimit = postWhere.length > 0 || postOrWhere !== null || postOrder !== null;

  let sql = `SELECT ${[...physNeeded].map(qid).join(", ")} FROM ${qid(q.from)}`;
  if (sqlConds.length) sql += ` WHERE ${sqlConds.join(" AND ")}`;
  if (sqlOrder.length) sql += ` ORDER BY ${sqlOrder.join(", ")}`;
  sql += ` LIMIT ${postLimit ? HARD_CAP : limit}`;

  const boolCols = new Set<string>();
  const jsonCols = new Set<string>();
  for (const c of physicalColumns(t)) {
    if (!physNeeded.has(c.name)) continue;
    if (c.type === "boolean") boolCols.add(c.name);
    if (c.type === "json" || c.type === "attachment"
        || (c.type === "relation" && c.relation?.cardinality === "many"))
      jsonCols.add(c.name);
  }

  const relationDisplayNames = new Set(finalSelect);
  for (const condition of postWhere) relationDisplayNames.add(condition.field);
  for (const group of postOrWhere ?? []) for (const condition of group)
    relationDisplayNames.add(condition.field);
  for (const order of postOrder ?? []) relationDisplayNames.add(order.field);
  return {
    sql, params, table: q.from,
    computed: [...computedByName.values()],
    postWhere, postOrWhere, postOrder,
    finalSelect, limit, postLimit, boolCols, jsonCols,
    relationDisplays: [...relationDisplayNames].map(name => findColumn(t, name))
      .filter((column): column is RegColumn => column?.type === "relation"),
  };
}

// ---------- post-SQL condition evaluation (computed + connected fields) ----------
function relationIds(value: QueryValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function decodeTargetValue(column: RegColumn | undefined, value: SqlValue | undefined): QueryValue {
  if (value === undefined || value === null) return null;
  if (column?.type === "boolean") return value === 1;
  if (column?.type === "json" || column?.type === "attachment"
      || (column?.type === "relation" && column.relation?.cardinality === "many")) {
    if (typeof value !== "string") return null;
    try { return JSON.parse(value) as QueryValue; } catch { return value; }
  }
  return value as QueryValue;
}

function materializeConnected(
  driver: DbDriver,
  registry: Registry,
  source: RegTable,
  rows: QueryRow[],
  columns: Extract<CompiledComputed, { kind: "connected" }>[],
): void {
  for (const compiled of columns) {
    const definition = compiled.column.lookup ?? compiled.column.rollup;
    if (!definition) throw new ClayError("E_INTERNAL", "connected field definition vanished");
    const relation = findColumn(source, definition.relation_field);
    if (!relation?.relation) throw new ClayError("E_INTERNAL", "relation dependency vanished");
    const target = getTable(registry, relation.relation.target_table);
    const targetFieldName = definition.target_field;
    const targetField = targetFieldName ? findColumn(target, targetFieldName) : undefined;
    const ids = [...new Set(rows.flatMap(row => relationIds(row[definition.relation_field])))];
    const byId = new Map<string, QueryValue>();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      if (batch.length === 0) continue;
      const select = targetFieldName ? `"id", ${qid(targetFieldName)}` : `"id"`;
      const found = driver.select(
        `SELECT ${select} FROM ${qid(target.name)} WHERE "deleted_at" IS NULL`
          + ` AND "id" IN (${batch.map(() => "?").join(", ")})`,
        batch,
      );
      for (const item of found) byId.set(
        String(item.id),
        targetFieldName ? decodeTargetValue(targetField, item[targetFieldName]) : null,
      );
    }
    for (const row of rows) {
      const linked = relationIds(row[definition.relation_field]);
      const present = linked.filter(id => byId.has(id));
      if (compiled.column.type === "lookup") {
        const values = present.map(id => byId.get(id) ?? null);
        row[compiled.name] = relation.relation.cardinality === "one"
          ? (values[0] ?? null) : values;
        continue;
      }
      const operation = compiled.column.rollup?.operation;
      if (operation === "count") { row[compiled.name] = present.length; continue; }
      const values = present.map(id => byId.get(id) ?? null)
        .filter((value): value is string | number =>
          typeof value === "string" || typeof value === "number");
      if (operation === "sum" || operation === "avg") {
        const numbers = values.filter((value): value is number => typeof value === "number");
        const sum = numbers.reduce((total, value) => total + value, 0);
        row[compiled.name] = operation === "sum" ? sum
          : numbers.length === 0 ? null : sum / numbers.length;
      } else if (values.length === 0) {
        row[compiled.name] = null;
      } else {
        row[compiled.name] = values.reduce((best, value) => {
          const better = operation === "min" ? value < best : value > best;
          return better ? value : best;
        });
      }
    }
  }
}

function hydrateRelationDisplays(
  driver: DbDriver,
  registry: Registry,
  rows: QueryRow[],
  columns: RegColumn[],
): void {
  for (const column of columns) {
    const relation = column.relation;
    if (!relation) continue;
    const target = getTable(registry, relation.target_table);
    const display = relation.display_field
      ? findColumn(target, relation.display_field)
      : target.columns.find(candidate => !candidate.hidden && !candidate.inactive
        && (candidate.type === "text" || candidate.type === "rich_text" || candidate.type === "enum"));
    const ids = [...new Set(rows.flatMap(row => relationIds(row[column.name])))];
    const labels = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      if (batch.length === 0) continue;
      const select = display ? `"id", ${qid(display.name)}` : `"id"`;
      for (const item of driver.select(
        `SELECT ${select} FROM ${qid(target.name)} WHERE "deleted_at" IS NULL`
          + ` AND "id" IN (${batch.map(() => "?").join(", ")})`, batch)) {
        labels.set(String(item.id), display ? String(item[display.name] ?? "Untitled") : String(item.id));
      }
    }
    const link = (id: string): RecordLink => ({
      id, table: target.name, label: labels.get(id) ?? "Missing record",
    });
    for (const row of rows) {
      const idsForRow = relationIds(row[column.name]);
      row[column.name] = relation.cardinality === "one"
        ? (idsForRow[0] ? link(idsForRow[0]) : null)
        : idsForRow.map(link);
    }
  }
}

function isRecordLink(value: QueryValue): value is RecordLink {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.id === "string" && typeof value.label === "string"
    && typeof value.table === "string";
}

function comparable(value: QueryValue): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number"
      || typeof value === "boolean") return value;
  if (isRecordLink(value)) return value.label;
  if (Array.isArray(value)) return value.map(item => comparable(item) ?? "").join(", ");
  return JSON.stringify(value);
}

function evalCond(row: QueryRow, cond: ConditionT, now: Date): boolean {
  const value = row[cond.field] ?? null;
  const v = comparable(value);
  const cv = cond.value as string | number | boolean | (string | number)[] | undefined;
  const equals = (target: unknown): boolean => {
    if (isRecordLink(value)) return value.id === String(target);
    if (Array.isArray(value) && value.every(item => isRecordLink(item)))
      return value.some(item => item.id === String(target));
    return v === target;
  };
  switch (cond.op) {
    case "eq": return equals(cv);
    case "neq": return !equals(cv);
    case "gt": return v !== null && cv !== undefined && v > (cv as string | number);
    case "gte": return v !== null && cv !== undefined && v >= (cv as string | number);
    case "lt": return v !== null && cv !== undefined && v < (cv as string | number);
    case "lte": return v !== null && cv !== undefined && v <= (cv as string | number);
    case "contains": {
      const needle = String(cv ?? "").toLocaleLowerCase();
      if (typeof value === "string") return value.toLocaleLowerCase().includes(needle);
      if (isRecordLink(value)) return value.id === String(cv)
        || value.label.toLocaleLowerCase().includes(needle);
      return Array.isArray(value) && value.some(item => isRecordLink(item)
        ? item.id === String(cv) || item.label.toLocaleLowerCase().includes(needle)
        : String(comparable(item) ?? "").toLocaleLowerCase().includes(needle));
    }
    case "in": return Array.isArray(cv) && cv.some(candidate => equals(candidate));
    case "is_null": return value === null;
    case "not_null": return value !== null;
    case "within_days": {
      if (typeof v !== "string") return false;
      const lower = localStartOfDayIso(now);
      return v >= lower && v < plusDaysIso(lower, (cv as number) + 1);
    }
    case "older_than_days": {
      if (typeof v !== "string") return false;
      return v < plusDaysIso(localStartOfDayIso(now), -(cv as number));
    }
  }
}

export function rowMatchesConditions(
  row: QueryRow,
  conditions: NonNullable<QueryT["where"]>,
  now: Date = new Date(),
): boolean {
  return conditions.every(condition => evalCond(row, condition, now));
}

export function runQuery(driver: DbDriver, reg: Registry, q: QueryT, now: Date = new Date()): QueryRow[] {
  const c = compileQuery(reg, q, now);
  let rows: QueryRow[] = driver.select(c.sql, c.params) as QueryRow[];

  for (const row of rows) {
    for (const name of c.boolCols)
      if (row[name] !== null && row[name] !== undefined) row[name] = row[name] === 1;
    for (const name of c.jsonCols)
      if (typeof row[name] === "string") {
        try { row[name] = JSON.parse(row[name] as string) as QueryValue; }
        catch { /* leave raw text */ }
      }
  }
  for (const cc of c.computed) {
    if (cc.kind !== "expression") continue;
    for (const row of rows)
      row[cc.name] = evalExpr(cc.ast, row as Record<string, ExprValue>);
  }
  materializeConnected(
    driver, reg, getTable(reg, c.table), rows,
    c.computed.filter((cc): cc is Extract<CompiledComputed, { kind: "connected" }> =>
      cc.kind === "connected"),
  );
  hydrateRelationDisplays(driver, reg, rows, c.relationDisplays);

  if (c.postWhere.length)
    rows = rows.filter(r => c.postWhere.every(cond => evalCond(r, cond, now)));
  if (c.postOrWhere)
    rows = rows.filter(r => c.postOrWhere!.some(g => g.every(cond => evalCond(r, cond, now))));
  if (c.postOrder) {
    const order = c.postOrder;
    rows = [...rows].sort((a, b) => {
      for (const o of order) {
        const av = comparable(a[o.field] ?? null);
        const bv = comparable(b[o.field] ?? null);
        if (av === bv) continue;
        if (av === null) return 1;
        if (bv === null) return -1;
        const cmp = av < bv ? -1 : 1;
        return o.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }
  if (c.postLimit) rows = rows.slice(0, c.limit);

  // project the caller-visible columns only (doc 03: registered columns only)
  const want = new Set(c.finalSelect);
  return rows.map(r => {
    const out: QueryRow = {};
    for (const name of c.finalSelect) if (name in r || want.has(name)) out[name] = r[name] ?? null;
    return out;
  });
}
