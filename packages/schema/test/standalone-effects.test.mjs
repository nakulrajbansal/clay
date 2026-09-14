import { expect, it } from 'vitest';
import { z } from 'zod';
import { encodeSchema } from '../scripts/standalone-compiler.mjs';
import { standalone } from '../src/standalone/runtime.mjs';

it('keeps chained refinements distinct and ordered, including dirty and fatal child results',()=>{
  const hooks=new Map();
  const first=value=>value.startsWith('a'); const second=value=>value.endsWith('z');
  const a=z.string().min(2).refine(first,'first'), b=a.refine(second,'second');
  hooks.set(a,{kind:'refine',callback:first,message:'first'});hooks.set(b,{kind:'refine',callback:second,message:'second'});
  const compact=standalone(encodeSchema(b,{hook:s=>hooks.get(s)}));
  for(const value of ['az','ax','xz','xx','',null]) {
    const left=compact.safeParse(value),right=b.safeParse(value);
    expect(left.success).toBe(right.success);if(!left.success)expect(left.error.message).toBe(right.error.message);
  }
});
it('preserves default output without sharing parsed arrays across requests',()=>{
  const schema=z.array(z.string()).default([]);
  const compact=standalone(encodeSchema(schema,{hook:s=>s===schema?{kind:'default',value:[]}:undefined}));
  const first=compact.parse(undefined); first.push('changed');
  expect(compact.parse(undefined)).toEqual(schema.parse(undefined));
  expect(compact.safeParse(null).error.message).toBe(schema.safeParse(null).error.message);
});
it('keeps the explicitly approved ArrayBuffer custom predicate, including fatal errors',()=>{
  const predicate=value=>Object.prototype.toString.call(value)==='[object ArrayBuffer]';
  const schema=z.custom(predicate,'ArrayBuffer required');
  const compact=standalone(encodeSchema(schema,{hook:s=>s===schema?{kind:'arrayBuffer',callback:predicate,message:'ArrayBuffer required'}:undefined}));
  for(const input of [null,{},new Uint8Array(2),new ArrayBuffer(2),{[Symbol.toStringTag]:'ArrayBuffer'}]) {
    const left=compact.safeParse(input),right=schema.safeParse(input);
    expect(left.success).toBe(right.success);if(left.success)expect(left.data).toBe(right.data);else expect(left.error.message).toBe(right.error.message);
  }
});
