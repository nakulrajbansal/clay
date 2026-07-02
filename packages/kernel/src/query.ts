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
  type Registry, type RegTable, type ColumnKind,
  getTable, resolveField, physicalColumns, exprScope,
} from "./registry";
import {
  compileExpr, evalExpr, exprFields,
  type ExprAst, type ExprValue,
} from "./expr";

export type QueryRow = Record<string, ExprValue>;
type QueryT = import("@clay/schema").Query;
type ConditionT = NonNullable<QueryT["where"]>[number];

const DEFAULT_LIMIT = 500;
const HARD_CAP = 5000;

const qid = (name: string): string => `"${name}"`;

type CompiledComputed = { name: string; ast: ExprAst; deps: Set<string> };

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
};

function fieldKind(t: RegTable, name: string): { computed: boolean; type: ColumnKind } {
  const r = resolveField(t, name);
  if (r.kind === "kernel") return { computed: false, type: r.type };
  return { computed: r.kind === "computed", type: r.column.type };
}

function checkValueType(t: RegTable, cond: ConditionT): void {
  const v = cond.value;
  if (typeof v === "object" && v !== null && !Array.isArray(v))
    throw new ClayError("E_VALIDATION",
      "placeholder {$var} is only legal in declared_queries, not executable queries");
  const { type } = fieldKind(t, cond.field);
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
      need(type === "text" || type === "enum", "a text column");
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

function condToSql(t: RegTable, cond: ConditionT, now: Date, params: SqlValue[]): string {
  checkValueType(t, cond);
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
    for (const g of groupBy)
      if (fieldKind(t, g).computed)
        throw new ClayError("E_TYPE", `computed column '${g}' not allowed in groupBy (v1)`);
    for (const a of aggregates)
      if (fieldKind(t, a.field).computed)
        throw new ClayError("E_TYPE", `computed column '${a.field}' not allowed in aggregate (v1)`);
    const params: SqlValue[] = [];
    const conds: string[] = [];
    if (!q.includeDeleted) conds.push(`"deleted_at" IS NULL`);
    for (const c of q.where ?? []) {
      if (fieldKind(t, c.field).computed)
        throw new ClayError("E_TYPE", `computed column '${c.field}' not allowed in aggregate where (v1)`);
      conds.push(condToSql(t, c, now, params));
    }
    if (q.orWhere?.length) {
      const groups = q.orWhere.map(g => {
        for (const c of g)
          if (fieldKind(t, c.field).computed)
            throw new ClayError("E_TYPE", "computed column not allowed in aggregate orWhere (v1)");
        return `(${g.map(c => condToSql(t, c, now, params)).join(" AND ")})`;
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
      boolCols: new Set(), jsonCols: new Set(),
    };
  }

  // ---- row queries ----
  const defaultSelect = (): string[] => {
    const cols = ["id", "created_at", "updated_at"];
    if (q.includeDeleted) cols.push("deleted_at");
    for (const c of t.columns) if (!c.hidden) cols.push(c.name);
    return cols;
  };
  const finalSelect = q.select ?? defaultSelect();

  const scope = exprScope(t);
  const computedByName = new Map<string, CompiledComputed>();
  const wantComputed = (name: string): CompiledComputed => {
    let cc = computedByName.get(name);
    if (!cc) {
      const col = resolveField(t, name);
      if (col.kind !== "computed") throw new ClayError("E_INTERNAL", "not computed");
      const { ast } = compileExpr(col.column.expr ?? "", scope);
      cc = { name, ast, deps: exprFields(ast) };
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
    checkValueType(t, c);
    if (fieldKind(t, c.field).computed) {
      for (const d of wantComputed(c.field).deps) physNeeded.add(d);
      postWhere.push(c);
    } else sqlConds.push(condToSql(t, c, now, params));
  }

  let postOrWhere: ConditionT[][] | null = null;
  if (q.orWhere?.length) {
    const touchesComputed = q.orWhere.some(g => g.some(c => fieldKind(t, c.field).computed));
    if (touchesComputed) {
      for (const g of q.orWhere) for (const c of g) {
        checkValueType(t, c);
        if (fieldKind(t, c.field).computed)
          for (const d of wantComputed(c.field).deps) physNeeded.add(d);
        else physNeeded.add(c.field);
      }
      postOrWhere = q.orWhere;
    } else {
      const groups = q.orWhere.map(g =>
        `(${g.map(c => condToSql(t, c, now, params)).join(" AND ")})`);
      sqlConds.push(`(${groups.join(" OR ")})`);
    }
  }

  let sqlOrder: string[] = [];
  let postOrder: { field: string; dir: "asc" | "desc" }[] | null = null;
  if (q.orderBy?.length) {
    const touchesComputed = q.orderBy.some(o => fieldKind(t, o.field).computed);
    if (touchesComputed) {
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
  // post conditions on computed fields may also order/filter on them
  for (const c of postWhere) void wantComputed(c.field);

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
    if (c.type === "json") jsonCols.add(c.name);
  }

  return {
    sql, params, table: q.from,
    computed: [...computedByName.values()],
    postWhere, postOrWhere, postOrder,
    finalSelect, limit, postLimit, boolCols, jsonCols,
  };
}

// ---------- post-SQL condition evaluation (computed fields) ----------
function evalCond(row: QueryRow, cond: ConditionT, now: Date): boolean {
  const v = row[cond.field] ?? null;
  const cv = cond.value as string | number | boolean | (string | number)[] | undefined;
  switch (cond.op) {
    case "eq": return v === cv;
    case "neq": return v !== cv;
    case "gt": return v !== null && cv !== undefined && v > (cv as string | number);
    case "gte": return v !== null && cv !== undefined && v >= (cv as string | number);
    case "lt": return v !== null && cv !== undefined && v < (cv as string | number);
    case "lte": return v !== null && cv !== undefined && v <= (cv as string | number);
    case "contains": return typeof v === "string" && v.includes(cv as string);
    case "in": return Array.isArray(cv) && cv.includes(v as string | number);
    case "is_null": return v === null;
    case "not_null": return v !== null;
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

export function runQuery(driver: DbDriver, reg: Registry, q: QueryT, now: Date = new Date()): QueryRow[] {
  const c = compileQuery(reg, q, now);
  let rows: QueryRow[] = driver.select(c.sql, c.params) as QueryRow[];

  for (const row of rows) {
    for (const name of c.boolCols)
      if (row[name] !== null && row[name] !== undefined) row[name] = row[name] === 1;
    for (const name of c.jsonCols)
      if (typeof row[name] === "string") {
        try { row[name] = JSON.parse(row[name] as string) as ExprValue; }
        catch { /* leave raw text */ }
      }
  }
  for (const cc of c.computed)
    for (const row of rows) row[cc.name] = evalExpr(cc.ast, row);

  if (c.postWhere.length)
    rows = rows.filter(r => c.postWhere.every(cond => evalCond(r, cond, now)));
  if (c.postOrWhere)
    rows = rows.filter(r => c.postOrWhere!.some(g => g.every(cond => evalCond(r, cond, now))));
  if (c.postOrder) {
    const order = c.postOrder;
    rows = [...rows].sort((a, b) => {
      for (const o of order) {
        const av = a[o.field] ?? null;
        const bv = b[o.field] ?? null;
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
