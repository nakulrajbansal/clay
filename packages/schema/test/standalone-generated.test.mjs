import { describe, expect, it } from "vitest";
import { generateStandalone } from "../scripts/generate-standalone.mjs";
const oracles=import.meta.glob('../src/*.ts',{eager:true});
const generated=import.meta.glob('../src/standalone/*.mjs',{eager:true});
const modules=['index','archive','backup','catalog','daily-home','intake','intake-workflow','legacy-owner','owner-witness','projection','restore','share','import','import-staging','private-metrics','saved-views','intake-state','worker-contracts'];
const base=[undefined,null,true,false,0,-0,NaN,Infinity,-Infinity,0.2,'','💠','\ud800',1n,Symbol('synthetic'),()=>1,[],{},new Date(0),new Map(),new Set(),/x/];
const texts=['x','0','1','2026-09-14','2026-09-14T00:00:00.000Z','UTC','America/New_York','https://example.test',
  '019922e0-0000-7000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  ...['app','gen','auth','ns','lease','op','req','rel','form','sub','inb','dsp','shr','series','target','backup'].map(prefix=>`${prefix}_${'a'.repeat(26)}`),
  ...['tbl','fld'].map(prefix=>`${prefix}_019922e0-0000-7000-8000-000000000001`),
  'sha256:'+'0'.repeat(64),'0'.repeat(64),'a'.repeat(43),'a'.repeat(16),'a'.repeat(22)];
function seed(schema,depth=0) {
  if(depth>14)return null;
  const d=schema._def;
  switch(d.typeName) {
    case 'ZodString': return texts.find(text=>schema.safeParse(text).success)??'x';
    case 'ZodNumber': return [0,1,-1,d.checks.find(c=>c.kind==='min')?.value].find(n=>schema.safeParse(n).success)??0;
    case 'ZodLiteral': return d.value;
    case 'ZodEnum': return d.values[0];
    case 'ZodBoolean': return false;
    case 'ZodNull': case 'ZodLazy': return null;
    case 'ZodOptional': case 'ZodUnknown': case 'ZodAny': return undefined;
    case 'ZodNullable': return null;
    case 'ZodDefault': return d.defaultValue();
    case 'ZodEffects': return seed(d.schema,depth+1);
    case 'ZodArray': return Array.from({length:d.exactLength?.value??d.minLength?.value??0},()=>seed(d.type,depth+1));
    case 'ZodObject': return Object.fromEntries(Object.entries(d.shape()).map(([k,s])=>[k,seed(s,depth+1)]));
    case 'ZodRecord': return {};
    case 'ZodTuple': return d.items.map(s=>seed(s,depth+1));
    case 'ZodUnion': case 'ZodDiscriminatedUnion': return seed(d.options[0],depth+1);
    default: throw new Error(`Unknown oracle type ${d.typeName}`);
  }
}
function result(schema,value) {
  try {
    const r=schema.safeParse(value);
    return r.success?{success:true,data:r.data}:{success:false,message:r.error.message,
      issues:JSON.parse(JSON.stringify(r.error.issues,(_key,x)=>typeof x==='bigint'?{bigint:String(x)}:x))};
  }catch(error){return {thrown:error.name,message:error.message};}
}
// Exercise nested union alternatives and each scalar/cardinality boundary, not
// just the first generated example. Limits above 4096 have dedicated bounded
// import/archive payload packets; don't allocate every large corpus at once.
function* variants(schema, depth=0) {
  if(depth>6)return;
  const d=schema._def;
  switch(d.typeName) {
    case 'ZodEffects': yield* variants(d.schema,depth+1); break;
    case 'ZodOptional': case 'ZodNullable': case 'ZodDefault': yield seed(d.innerType); yield* variants(d.innerType,depth+1);break;
    case 'ZodUnion': case 'ZodDiscriminatedUnion':
      for(const option of d.options) { yield seed(option); yield* variants(option,depth+1); } break;
    case 'ZodObject': {
      const sample=seed(schema);
      for(const [key,child]of Object.entries(d.shape()))for(const value of variants(child,depth+1))yield {...sample,[key]:value};
      break;
    }
    case 'ZodEnum': yield* d.values;break;
    case 'ZodNumber':
      for(const c of d.checks)if(typeof c.value==='number')yield* [c.value-1,c.value,c.value+1,c.value+0.5];break;
    case 'ZodString':
      for(const c of d.checks)if(typeof c.value==='number'&&c.value<=4096)
        for(const n of new Set([Math.max(0,c.value-1),c.value,c.value+1]))yield 'x'.repeat(n);
      break;
    case 'ZodArray':
      for(const limit of [d.minLength,d.maxLength,d.exactLength])if(limit&&limit.value<=4096) {
        const value=seed(d.type);
        for(const n of new Set([Math.max(0,limit.value-1),limit.value,limit.value+1]))yield Array(n).fill(value);
      }
      yield new Array(Math.max(1,d.minLength?.value??0));
      for(const value of variants(d.type,depth+1))yield [value];break;
    case 'ZodRecord': yield Object.create({inherited:seed(d.valueType)});break;
  }
}
describe('generated standalone closed production contracts',()=>{
  it('is deterministic and bound to exact approved source and pinned Zod implementation',async()=>{
    const report=await generateStandalone({check:true}); expect(report).toMatchObject({modules:18,validators:368,files:38});
  });
  for(const name of modules) {
    const oracle=oracles[`../src/${name}.ts`]; const compact=generated[`../src/standalone/${name}.mjs`];
    for(const [key,schema]of Object.entries(oracle))if(schema?._def)it(`${name}/${key}: decisions, parsed data and serialized issues`,()=>{
      expect(compact[key]).toBeDefined(); const example=seed(schema);
      const inputs=[...base,...texts,example];
      if(example&&typeof example==='object'&&!Array.isArray(example)) {
        inputs.push({...example,extra:true},Object.assign(Object.create(null),example),Object.assign(Object.create({inherited:true}),example),
          {...example,[Symbol('extra')]:true});
        for(const field of Object.keys(example)) {
          const missing={...example};delete missing[field];inputs.push(missing);
          for(const value of [undefined,null,'',[],{},NaN,Infinity,1n]) inputs.push({...example,[field]:value});
        }
      }
      for(const value of inputs) expect(result(compact[key],value),`${name}/${key}`).toEqual(result(schema,value));
      for(const value of variants(schema)) expect(result(compact[key],value),`${name}/${key}/nested-boundary`).toEqual(result(schema,value));
    });
  }
});
