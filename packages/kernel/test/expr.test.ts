// ExpressionEngine unit tests: grammar table, type-check failures, budget
// trip (doc 08 §1).
import { describe, expect, it } from "vitest";
import { ClayError, compileExpr, evalExpr, parseExpr, typecheckExpr } from "../src/index";
import type { ExprScope, ExprValue } from "../src/index";

const scope: ExprScope = {
  a: "number", b: "number", s: "text", t: "text",
  d1: "date", d2: "date", f: "bool",
};

function run(src: string, row: Record<string, ExprValue> = {}): ExprValue {
  const { ast } = compileExpr(src, scope);
  return evalExpr(ast, row);
}

function expectExprError(fn: () => unknown): void {
  try {
    fn();
    expect.fail("expected E_EXPR");
  } catch (e) {
    expect(e).toBeInstanceOf(ClayError);
    expect((e as ClayError).code).toBe("E_EXPR");
  }
}

describe("grammar and evaluation", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["-2 * 3", -6],
    ["10 % 3", 1],
    ["7 / 2", 3.5],
    ["2 <= 2", true],
    ["1 < 2 and 2 < 3", true],
    ["1 > 2 or 2 > 3", false],
    ["not 1 > 2", true],
    ["min(3, 1, 2)", 1],
    ["max(3, 1, 2)", 3],
    ["abs(-4)", 4],
    ["round(2.5)", 3],
    ["floor(2.9)", 2],
    ["ceil(2.1)", 3],
    ["len('abc')", 3],
    ["lower('AbC')", "abc"],
    ["contains('hello', 'ell')", true],
    ["concat('a', 1, 'b')", "a1b"],
    ["if(2 > 1, 'big', 'small')", "big"],
    ["1 / 0", null],
    ["1 % 0", null],
  ])("%s -> %s", (src, want) => {
    expect(run(src as string)).toBe(want);
  });

  it("fields, dates, and coalesce", () => {
    expect(run("a + b", { a: 2, b: 3 })).toBe(5);
    expect(run("days_between(d1, d2)", { d1: "2026-01-01", d2: "2026-01-11" })).toBe(10);
    expect(run("coalesce(a, 5)", { a: null })).toBe(5);
    expect(run("coalesce(s, 'x')", { s: "y" })).toBe("y");
  });

  it("null propagation keeps evaluation total (PB4)", () => {
    expect(run("a + 1", { a: null })).toBeNull();
    expect(run("a > 1", { a: null })).toBeNull();
    expect(run("not f", { f: null })).toBeNull();
    expect(run("lower(s)", { s: null })).toBeNull();
    expect(run("f and a > 1", { f: false, a: null })).toBe(false);
    expect(run("f or a > 1", { f: true, a: null })).toBe(true);
    expect(run("concat(s, 'x')", { s: null })).toBe("x");
    expect(run("days_between(d1, d2)", { d1: "nonsense", d2: "2026-01-01" })).toBeNull();
  });
});

describe("static type check (E_EXPR at check time)", () => {
  it.each([
    "1 + 'a'",
    "unknown_field + 1",
    "lower(1)",
    "1 < 'a'",
    "if(1, 2, 3)",
    "if(f, 1, 'a')",
    "s and f",
    "not a",
    "-s",
    "days_between(s, d1)",
    "coalesce(a, s)",
    "contains(a, s)",
  ])("%s", (src) => {
    expectExprError(() => compileExpr(src, scope));
  });
});

describe("parse errors", () => {
  it.each([
    "1 +",
    "foo(1)",
    "sqrt(1)",
    "1 ; 2",
    "'unterminated",
    "min(1)",
    "if(f, 1)",
    "1 2",
    "",
  ])("%s", (src) => {
    expectExprError(() => parseExpr(src));
  });

  it("rejects over-deep nesting", () => {
    const deep = "(".repeat(40) + "1" + ")".repeat(40);
    expectExprError(() => parseExpr(deep));
  });

  it("rejects over-long sources", () => {
    expectExprError(() => parseExpr("1 + " + "1 + ".repeat(150) + "1"));
  });
});

describe("evaluation budget", () => {
  it("trips E_EXPR when the step budget is exhausted", () => {
    const ast = parseExpr("1 + 2 + 3 + 4 + 5");
    expect(typecheckExpr(ast, scope)).toBe("number");
    expectExprError(() => evalExpr(ast, {}, 3));
  });
});
