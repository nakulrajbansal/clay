import { describe, expect, it } from "vitest";
import { z } from "zod";
import { encodeSchema, assertApprovedSource, assertApprovedManifest } from "../scripts/standalone-compiler.mjs";

describe("closed standalone compiler", () => {
  it("rejects unapproved source bytes, including changed refinement helpers", () => {
    expect(() => assertApprovedSource("index.ts", "drift", { "index.ts": "0".repeat(64) })).toThrow(/source drift/);
    expect(() => assertApprovedSource("new.ts", "", {})).toThrow(/unapproved/);
  });
  it("rejects missing, extra or path-escaping compiler inputs before reading them", () => {
    const good={'schema.ts':'0'.repeat(64)};
    expect(()=>assertApprovedManifest(good,['schema.ts'])).not.toThrow();
    for(const bad of [{},{...good,'../unrelated': '0'.repeat(64)},{'schema.ts':'not-a-digest'}])
      expect(()=>assertApprovedManifest(bad,['schema.ts'])).toThrow(/input manifest/);
  });
  it("rejects unsupported schema kinds, effects, lazy recursion, and defaults", () => {
    for (const schema of [z.date(), z.promise(z.string()), z.string().transform(x => x),
      z.string().refine(x => !!x), z.custom(() => true), z.lazy(() => z.string()),
      z.string().default(() => "x"), z.object({}).catchall(z.string()), z.string().catch("x")]) {
      expect(() => encodeSchema(schema)).toThrow(/Unsupported|Unapproved/);
    }
  });
  it("rejects non-serializable literals and check metadata", () => {
    for (const schema of [z.literal(NaN), z.literal(Infinity), z.literal(Symbol('x')), z.literal(1n), z.number().min(Infinity), z.string().max(NaN), z.array(z.string()).max(Infinity)])
      expect(() => encodeSchema(schema)).toThrow(/Unsupported/);
  });
  it("rejects unknown AST fields and checks instead of silently ignoring drift", () => {
    const field = z.string(); field._def.unreviewed = true;
    expect(() => encodeSchema(field)).toThrow(/Unsupported/);
    const check = z.string(); check._def.checks.push({ kind: "future" });
    expect(() => encodeSchema(check)).toThrow(/Unsupported/);
  });
  it("uses compact closed object modes and positional cardinality metadata", () => {
    expect(encodeSchema(z.object({ a:z.string() }).strict())).toEqual([6,{a:[0,[]]},1]);
    expect(encodeSchema(z.array(z.string()).max(2))[3]).toEqual([2,undefined]);
  });
});
