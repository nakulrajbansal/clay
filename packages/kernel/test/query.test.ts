// QueryCompiler golden tests: exact SQL + params per op (doc 08 §1), the
// injection corpus (must fail BEFORE SQL assembly), and computed-column
// splitting.
import { describe, expect, it } from "vitest";
import { ClayError, compileQuery } from "../src/index";
import type { Registry } from "../src/index";
import { projectsRegistry } from "./helpers";

const NOW = new Date(2026, 6, 2, 15, 30);   // local 2026-07-02
const dayStart = new Date(2026, 6, 2).toISOString();
const plusDays = (d: number): string =>
  new Date(Date.parse(dayStart) + d * 86_400_000).toISOString();

const reg = projectsRegistry();
const ALL_COLS = `"id", "created_at", "updated_at", "name", "owner", "status", "next_milestone", "slipped_milestones", "open_risks"`;

function compile(q: object): { sql: string; params: unknown[] } {
  const c = compileQuery(reg, q as Parameters<typeof compileQuery>[1], NOW);
  return { sql: c.sql, params: c.params };
}

describe("golden SQL per operator", () => {
  it("default select", () => {
    expect(compile({ from: "projects" })).toEqual({
      sql: `SELECT ${ALL_COLS} FROM "projects" WHERE "deleted_at" IS NULL LIMIT 500`,
      params: [],
    });
  });

  it("eq", () => {
    expect(compile({ from: "projects", where: [{ field: "owner", op: "eq", value: "Dev" }] })).toEqual({
      sql: `SELECT ${ALL_COLS} FROM "projects" WHERE "deleted_at" IS NULL AND "owner" = ? LIMIT 500`,
      params: ["Dev"],
    });
  });

  it("neq / gt / gte / lt / lte", () => {
    const { sql, params } = compile({
      from: "projects",
      where: [
        { field: "owner", op: "neq", value: "Dev" },
        { field: "slipped_milestones", op: "gt", value: 1 },
        { field: "open_risks", op: "gte", value: 2 },
        { field: "slipped_milestones", op: "lt", value: 9 },
        { field: "open_risks", op: "lte", value: 8 },
      ],
    });
    expect(sql).toBe(
      `SELECT ${ALL_COLS} FROM "projects" WHERE "deleted_at" IS NULL AND "owner" != ? AND ` +
      `"slipped_milestones" > ? AND "open_risks" >= ? AND "slipped_milestones" < ? AND "open_risks" <= ? LIMIT 500`);
    expect(params).toEqual(["Dev", 1, 2, 9, 8]);
  });

  it("contains escapes LIKE metacharacters", () => {
    expect(compile({ from: "projects", where: [{ field: "name", op: "contains", value: "50%_a\\b" }] })).toEqual({
      sql: `SELECT ${ALL_COLS} FROM "projects" WHERE "deleted_at" IS NULL AND "name" LIKE ? ESCAPE '\\' LIMIT 500`,
      params: ["%50\\%\\_a\\\\b%"],
    });
  });

  it("in (and empty in matches nothing)", () => {
    expect(compile({ from: "projects", where: [{ field: "status", op: "in", value: ["red", "amber"] }] }).sql)
      .toContain(`"status" IN (?, ?)`);
    expect(compile({ from: "projects", where: [{ field: "status", op: "in", value: [] }] }).sql)
      .toContain("1 = 0");
  });

  it("is_null / not_null", () => {
    const { sql, params } = compile({
      from: "projects",
      where: [{ field: "next_milestone", op: "is_null" }, { field: "owner", op: "not_null" }],
    });
    expect(sql).toContain(`"next_milestone" IS NULL AND "owner" IS NOT NULL`);
    expect(params).toEqual([]);
  });

  it("within_days compares against the local day window (G7)", () => {
    expect(compile({ from: "projects", where: [{ field: "next_milestone", op: "within_days", value: 14 }] })).toEqual({
      sql: `SELECT ${ALL_COLS} FROM "projects" WHERE "deleted_at" IS NULL AND ("next_milestone" >= ? AND "next_milestone" < ?) LIMIT 500`,
      params: [dayStart, plusDays(15)],
    });
  });

  it("older_than_days excludes nulls", () => {
    expect(compile({ from: "projects", where: [{ field: "next_milestone", op: "older_than_days", value: 30 }] })).toEqual({
      sql: `SELECT ${ALL_COLS} FROM "projects" WHERE "deleted_at" IS NULL AND ("next_milestone" < ? AND "next_milestone" IS NOT NULL) LIMIT 500`,
      params: [plusDays(-30)],
    });
  });

  it("orWhere becomes OR of AND-groups", () => {
    const { sql, params } = compile({
      from: "projects",
      orWhere: [
        [{ field: "status", op: "eq", value: "red" }],
        [{ field: "owner", op: "eq", value: "Dev" }, { field: "open_risks", op: "gt", value: 2 }],
      ],
    });
    expect(sql).toContain(`(("status" = ?) OR ("owner" = ? AND "open_risks" > ?))`);
    expect(params).toEqual(["red", "Dev", 2]);
  });

  it("orderBy and explicit select and limit", () => {
    expect(compile({
      from: "projects", select: ["name", "owner"],
      orderBy: [{ field: "next_milestone", dir: "asc" }], limit: 10,
    })).toEqual({
      sql: `SELECT "id", "name", "owner" FROM "projects" WHERE "deleted_at" IS NULL ORDER BY "next_milestone" ASC LIMIT 10`,
      params: [],
    });
  });

  it("includeDeleted drops the soft-delete filter", () => {
    expect(compile({ from: "projects", includeDeleted: true }).sql).not.toContain("deleted_at\" IS NULL");
  });

  it("groupBy + aggregate", () => {
    expect(compile({
      from: "projects", groupBy: ["status"],
      aggregate: [{ fn: "count", field: "status", as: "n" }],
      orderBy: [{ field: "n", dir: "desc" }],
    })).toEqual({
      sql: `SELECT "status", COUNT("status") AS "n" FROM "projects" WHERE "deleted_at" IS NULL GROUP BY "status" ORDER BY "n" DESC LIMIT 500`,
      params: [],
    });
  });
});

describe("limits and refusals", () => {
  const expectCode = (fn: () => unknown, code: string): void => {
    try { fn(); expect.fail(`expected ${code}`); }
    catch (e) { expect((e as ClayError).code).toBe(code); }
  };

  it("limit beyond the hard cap is E_LIMIT", () => {
    expectCode(() => compile({ from: "projects", limit: 6000 }), "E_LIMIT");
  });
  it("unknown table is E_TABLE_UNKNOWN", () => {
    expectCode(() => compile({ from: "nope" }), "E_TABLE_UNKNOWN");
  });
  it("unknown column is E_COLUMN_UNKNOWN", () => {
    expectCode(() => compile({ from: "projects", select: ["nope"] }), "E_COLUMN_UNKNOWN");
  });
  it("$var placeholders are not executable", () => {
    expectCode(() => compile({
      from: "projects", where: [{ field: "owner", op: "eq", value: { $var: true } }],
    }), "E_VALIDATION");
  });
  it("type mismatches are E_TYPE", () => {
    expectCode(() => compile({
      from: "projects", where: [{ field: "owner", op: "within_days", value: 3 }],
    }), "E_TYPE");
    expectCode(() => compile({
      from: "projects", where: [{ field: "slipped_milestones", op: "contains", value: "x" }],
    }), "E_TYPE");
  });
});

describe("injection corpus: hostile identifiers fail before SQL assembly", () => {
  const hostile = [
    `name"; DROP TABLE projects; --`,
    `name" OR 1=1`,
    "name`; select",
    "NAME",             // idents are lowercase-only
    "na me",
    "деньги",
    "id; --",
    "__proto__",        // uppercase/underscore-start both fail Ident
  ];
  for (const field of hostile) {
    it(JSON.stringify(field), () => {
      try {
        compile({ from: "projects", where: [{ field, op: "eq", value: 1 }] });
        expect.fail("expected rejection");
      } catch (e) {
        expect(e).toBeInstanceOf(ClayError);
        expect(["E_VALIDATION", "E_COLUMN_UNKNOWN"]).toContain((e as ClayError).code);
      }
    });
  }

  it("hostile values only ever travel as parameters", () => {
    const { sql, params } = compile({
      from: "projects",
      where: [{ field: "name", op: "eq", value: `"; DROP TABLE projects; --` }],
    });
    expect(sql).not.toContain("DROP TABLE");
    expect(params).toEqual([`"; DROP TABLE projects; --`]);
  });
});

describe("computed columns split into post-SQL work", () => {
  const regC: Registry = projectsRegistry();
  regC.get("projects")!.columns.push({
    name: "health_score", type: "computed", required: false,
    expr: "100 - 10 * slipped_milestones - 5 * open_risks",
  });

  it("conditions on computed columns leave SQL and cap the scan", () => {
    const c = compileQuery(regC, {
      from: "projects",
      where: [{ field: "health_score", op: "lt", value: 60 }],
      orderBy: [{ field: "health_score", dir: "asc" }],
    }, NOW);
    expect(c.postWhere).toHaveLength(1);
    expect(c.postOrder).toHaveLength(1);
    expect(c.sql).toContain("LIMIT 5000");
    expect(c.sql).toContain(`"slipped_milestones"`);   // expr deps fetched
    expect(c.sql).not.toContain("health_score");
  });

  it("computed columns are rejected in groupBy/aggregate (Q16)", () => {
    try {
      compileQuery(regC, {
        from: "projects", groupBy: ["health_score"],
        aggregate: [{ fn: "count", field: "health_score", as: "n" }],
      }, NOW);
      expect.fail("expected E_TYPE");
    } catch (e) {
      expect((e as ClayError).code).toBe("E_TYPE");
    }
  });
});
