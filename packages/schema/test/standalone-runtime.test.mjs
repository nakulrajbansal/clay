import { describe, expect, it } from "vitest";
import { z } from "zod";
import { encodeSchema } from "../scripts/standalone-compiler.mjs";
import { standalone } from "../src/standalone/runtime.mjs";

function comparable(result) {
  return result.success ? { success: true, data: result.data }
    : { success: false, issues: JSON.parse(JSON.stringify(result.error.issues,
      (_key, item) => typeof item === "bigint" ? { bigint: String(item) } : item)), message: result.error.message };
}
function parity(schema, inputs) {
  const compiled = standalone(encodeSchema(schema));
  for (const input of inputs) expect(comparable(compiled.safeParse(input))).toEqual(comparable(schema.safeParse(input)));
}
const hostile = [undefined, null, true, false, 0, -0, NaN, Infinity, -Infinity, 0.2,
  "", "💠", "\ud800", 1n, Symbol("synthetic"), () => 1, [], {}, new Date(0), new Map(), new Set(), /x/];
describe("standalone parse semantics versus pinned Zod", () => {
  it("preserves scalar checks, check order, canonical outputs and issue messages", () => {
    for (const schema of [z.string(), z.string().min(2).max(4), z.string().regex(/^x+$/), z.string().trim().min(1), z.string().min(2).trim(),
      z.string().uuid(), z.string().url(), z.string().datetime(), z.string().datetime({offset:true}),
      z.number(), z.number().int().nonnegative().safe(), z.number().finite().min(-2).max(2),
      z.boolean(), z.null(), z.literal("yes"), z.literal(1), z.literal(0), z.literal(-0), z.enum(["a", "b"])])
      parity(schema, [...hostile, "x", "xxx", "xxxxx", "  x  ", " \t\n", "\u00a0\ufeffx\u2003", "2026-09-14T00:00:00.000Z", "2026-02-29T00:00:00Z", 2, 3, Number.MAX_SAFE_INTEGER + 1]);
  });
  it("preserves object unknown keys, prototypes, inherited values and getter order", () => {
    for (const schema of [z.object({a:z.string().optional(), b:z.unknown()}), z.object({a:z.string().optional()}).strict(), z.object({a:z.string().optional()}).passthrough()]) {
      parity(schema, [...hostile, {a:undefined}, {a:"x", extra:1}, Object.create({a:"x", extra:true}),
        Object.assign(Object.create(null), {a:"x"}), {[Symbol("extra")]:1}, JSON.parse('{"__proto__":1}')]);
    }
    const schema = z.object({a:z.string(), b:z.number()}).strict(); const compact = standalone(encodeSchema(schema));
    const seen=[]; const value={get a(){seen.push("a");return "x";},get b(){seen.push("b");return 1;}};
    schema.safeParse(value); const expected=[...seen]; seen.length=0; compact.safeParse(value); expect(seen).toEqual(expected);
  });
  it("does not skip or duplicate the oracle's observable type probes", () => {
    for(const schema of [z.unknown(),z.object({a:z.string()}).strict(),z.object({a:z.string()}).optional(),
      z.record(z.string()),z.array(z.string()),z.tuple([z.string()]),z.literal('a'),z.enum(['a','b']),
      z.union([z.string(),z.object({a:z.string()})])]) {
      const compact=standalone(encodeSchema(schema));const seen=[];
      const make=()=>({get then(){seen.push('then');return undefined;},get a(){seen.push('a');return 'x';}});
      schema.safeParse(make());const expected=[...seen];seen.length=0;compact.safeParse(make());expect(seen).toEqual(expected);
      const poisoned=()=>Object.defineProperty({},'then',{get(){throw new RangeError('synthetic probe');}});
      expect(()=>schema.safeParse(poisoned())).toThrow('synthetic probe');
      expect(()=>compact.safeParse(poisoned())).toThrow('synthetic probe');
    }
  });
  it("preserves sparse arrays, tuple cardinality and record key semantics", () => {
    for (const schema of [z.array(z.string()).min(1).max(2),z.array(z.unknown()).length(2),
      z.tuple([z.string(),z.number()]),z.record(z.string()),z.record(z.string().min(2),z.number())])
      parity(schema,[...hostile,new Array(2),["x"],["x",1],["x",1,2],{a:"x"},Object.create({a:"x"}),{__proto__:null,a:"x"}]);
  });
  it("preserves exact-length issue own properties, including undefined bounds", () => {
    const schema = z.array(z.string()).length(2), compact = standalone(encodeSchema(schema));
    for (const value of [[], ['a', 'b', 'c']]) {
      const expected = schema.safeParse(value).error.issues[0], actual = compact.safeParse(value).error.issues[0];
      expect(Reflect.ownKeys(actual)).toEqual(Reflect.ownKeys(expected));
      expect(actual).toStrictEqual(expected);
    }
  });
  it("preserves array access/length order, including a changing proxy length", () => {
    const schema=z.array(z.string()).length(2), compact=standalone(encodeSchema(schema));
    for(const size of [0,1,2,3]) {
      const inspect=parser=>{const seen=[];const input=new Proxy(Array(size).fill('x'),{get(target,key,receiver){seen.push(String(key));return Reflect.get(target,key,receiver);}});
        return {result:comparable(parser.safeParse(input)),seen};};
      expect(inspect(compact)).toEqual(inspect(schema));
    }
    const inspect=parser=>{let reads=0;const input=new Proxy(['a','b'],{get(target,key,receiver){
      if(key==='length')return [3,1,2,2,2][reads++]??2;return Reflect.get(target,key,receiver);
    }});return comparable(parser.safeParse(input));};
    expect(inspect(compact)).toEqual(inspect(schema));
  });
  it("preserves union dirty versus aborted and discriminator issue paths", () => {
    for(const schema of [z.union([z.string().min(3),z.number().int()]),
      z.discriminatedUnion("kind",[z.object({kind:z.literal("a"),x:z.string()}),z.object({kind:z.literal("b"),x:z.number()})])])
      parity(schema,[...hostile,{kind:"a",x:1},{kind:"b",x:1},{kind:"c"},"a",1.2]);
  });
});
