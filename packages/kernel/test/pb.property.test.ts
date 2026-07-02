// Property tests at W1 small scale (doc 08 §2; L3 raises runs to 10k):
// PB1 migrate/rollback round-trip and PB4 expression totality.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ClayError, compileExpr, deriveInverse, evalExpr, registryToJson,
  type ExprScope, type ExprValue, type ForwardOpT, type Registry,
} from "../src/index";
import { seededStore } from "./helpers";

// ---------- PB4: expression totality ----------
const scope: ExprScope = {
  a: "number", b: "number", s: "text", t: "text",
  d1: "date", d2: "date", f: "bool",
};

type Gen = fc.Arbitrary<string>;
function exprArb(depth: number): { num: Gen; text: Gen; bool: Gen } {
  const numBase = fc.oneof(
    fc.integer({ min: -99, max: 99 }).map(String),
    fc.constantFrom("a", "b"),
  );
  const textBase = fc.constantFrom("'abc'", "'x y'", "''", "s", "t");
  const boolBase = fc.constantFrom("true", "false", "f");
  if (depth === 0) return { num: numBase, text: textBase, bool: boolBase };
  const sub = exprArb(depth - 1);
  const num: Gen = fc.oneof(
    numBase,
    fc.tuple(sub.num, fc.constantFrom("+", "-", "*", "/", "%"), sub.num)
      .map(([l, op, r]) => `(${l} ${op} ${r})`),
    sub.num.map(x => `abs(${x})`),
    sub.num.map(x => `round(${x})`),
    fc.tuple(sub.num, sub.num).map(([x, y]) => `min(${x}, ${y})`),
    fc.tuple(sub.num, sub.num).map(([x, y]) => `coalesce(${x}, ${y})`),
    sub.text.map(x => `len(${x})`),
    fc.constant("days_between(d1, d2)"),
    fc.tuple(sub.bool, sub.num, sub.num).map(([c, x, y]) => `if(${c}, ${x}, ${y})`),
  );
  const text: Gen = fc.oneof(
    textBase,
    sub.text.map(x => `lower(${x})`),
    fc.tuple(sub.text, sub.num).map(([x, y]) => `concat(${x}, ${y})`),
    fc.tuple(sub.bool, sub.text, sub.text).map(([c, x, y]) => `if(${c}, ${x}, ${y})`),
    fc.tuple(sub.text, sub.text).map(([x, y]) => `coalesce(${x}, ${y})`),
  );
  const bool: Gen = fc.oneof(
    boolBase,
    fc.tuple(sub.num, fc.constantFrom("==", "!=", "<", "<=", ">", ">="), sub.num)
      .map(([l, op, r]) => `(${l} ${op} ${r})`),
    fc.tuple(sub.bool, fc.constantFrom("and", "or"), sub.bool)
      .map(([l, op, r]) => `(${l} ${op} ${r})`),
    sub.bool.map(x => `(not ${x})`),
    fc.tuple(sub.text, sub.text).map(([x, y]) => `contains(${x}, ${y})`),
  );
  return { num, text, bool };
}

const rowArb: fc.Arbitrary<Record<string, ExprValue>> = fc.record({
  a: fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null }),
  b: fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null }),
  s: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
  t: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
  d1: fc.option(fc.constantFrom("2026-01-01", "2026-07-02", "1999-12-31"), { nil: null }),
  d2: fc.option(fc.constantFrom("2026-03-15", "2030-01-01"), { nil: null }),
  f: fc.option(fc.boolean(), { nil: null }),
});

describe("PB4: expression totality (small scale)", () => {
  const { num, text, bool } = exprArb(3);
  const cases: [string, Gen, string][] = [
    ["number", num, "number"], ["text", text, "text"], ["bool", bool, "bool"],
  ];
  for (const [label, gen, wantType] of cases) {
    it(`well-typed ${label} expressions never throw at eval time`, () => {
      fc.assert(fc.property(gen, rowArb, (src, row) => {
        const { type } = compileExpr(src, scope);   // must not throw
        expect(type).toBe(wantType);
        evalExpr(compileExpr(src, scope).ast, row); // must not throw
      }), { numRuns: 200 });
    });
  }

  it("ill-typed expressions always fail at check time with E_EXPR", () => {
    const { num, text } = exprArb(2);
    const illTyped = fc.oneof(
      fc.tuple(num, num).map(([l, r]) => `(${l} and ${r})`),
      fc.tuple(num, text).map(([l, r]) => `(${l} == ${r})`),
      num.map(x => `lower(${x})`),
      num.map(x => `(not ${x})`),
      text.map(x => `(-${x})`),
      text.map(x => `days_between(${x}, d1)`),
    );
    fc.assert(fc.property(illTyped, (src) => {
      try {
        compileExpr(src, scope);
        return false;
      } catch (e) {
        return e instanceof ClayError && e.code === "E_EXPR";
      }
    }), { numRuns: 150 });
  });
});

// ---------- PB1: migrate/rollback round-trip ----------
type Ctx = { fresh: number };
const freshCol = (ctx: Ctx): string => `c${ctx.fresh++}`;
const freshTable = (ctx: Ctx): string => `t${ctx.fresh++}`;

/** Build one valid forward-op list for the current registry from two decisions. */
function buildOps(reg: Registry, d1: number, d2: number, ctx: Ctx): ForwardOpT[] {
  const projects = reg.get("projects")!;
  const userCols = projects.columns;
  const addColumn = (): ForwardOpT[] => [{
    op: "add_column", table: "projects",
    column: {
      name: freshCol(ctx),
      type: (["text", "number", "integer", "date"] as const)[d2 % 4]!,
      required: false,
    },
  }];
  switch (d1 % 9) {
    case 0: return addColumn();
    case 1: return [{ op: "create_computed", table: "projects", column: freshCol(ctx), expr: "40 + 2" }];
    case 2: {
      const visible = userCols.filter(c => !c.hidden);
      if (visible.length === 0) return addColumn();
      return [{ op: "hide_column", table: "projects", column: visible[d2 % visible.length]!.name }];
    }
    case 3: {
      const enums = userCols.filter(c => c.type === "enum");
      if (enums.length === 0) return addColumn();
      return [{ op: "add_enum_value", table: "projects",
        column: enums[d2 % enums.length]!.name, value: `v${ctx.fresh++}` }];
    }
    case 4: {
      if (userCols.length === 0) return addColumn();
      return [{ op: "rename_column", table: "projects",
        from: userCols[d2 % userCols.length]!.name, to: freshCol(ctx) }];
    }
    case 5: return [{ op: "create_table", table: freshTable(ctx),
      columns: [{ name: "label", type: "text", required: false }] }];
    case 6: {
      const name = freshCol(ctx);
      return [
        { op: "add_column", table: "projects",
          column: { name, type: "number", required: false } },
        { op: "backfill", table: "projects", column: name, value: 7 },
      ];
    }
    case 7: {
      const eligible = userCols.filter(c => c.type !== "computed" && !c.required);
      if (eligible.length === 0) return addColumn();
      return [{ op: "set_required", table: "projects",
        column: eligible[d2 % eligible.length]!.name, required: true }];
    }
    case 8: {
      const physical = userCols.filter(c => c.type !== "computed");
      if (physical.length === 0) return addColumn();
      return [{ op: "add_index", table: "projects", column: physical[d2 % physical.length]!.name }];
    }
    default: return addColumn();
  }
}

describe("PB1: migrate/rollback round-trip (small scale)", () => {
  it("apply all, roll back all -> schema equals seed, data bit-equal", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.tuple(fc.nat(999), fc.nat(999)), { minLength: 1, maxLength: 8 }),
      async (decisions) => {
        const store = await seededStore();
        try {
          const seedVersion = store.headVersion();
          const dump0 = JSON.stringify(store.dumpTable("projects"));
          const reg0 = registryToJson(store.registrySnapshot());
          const ctx: Ctx = { fresh: 0 };

          for (const [d1, d2] of decisions) {
            const reg = store.registrySnapshot();
            const operations = buildOps(reg, d1, d2, ctx);
            store.commit({
              intent: "pb1", summary: "PB1 plan.",
              migration: { operations, inverse: deriveInverse(operations, reg) },
            });
          }

          store.rollbackTo(seedVersion);
          expect(registryToJson(store.registrySnapshot())).toBe(reg0);
          expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);

          // roll forward across the whole chain (physical adds legitimately
          // reappear empty), then back again: still bit-equal to seed
          store.rollForwardTo(store.headVersion());
          store.rollbackTo(seedVersion);
          expect(registryToJson(store.registrySnapshot())).toBe(reg0);
          expect(JSON.stringify(store.dumpTable("projects"))).toBe(dump0);
        } finally {
          store.close();
        }
      },
    ), { numRuns: 25 });
  }, 120_000);
});
