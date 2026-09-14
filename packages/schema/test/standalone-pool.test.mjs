import { expect, it } from 'vitest';
import { internProgramFiles } from '../scripts/standalone-pool.mjs';
const atom='[0, [[3, /^synthetic_[a-z2-7]{26}$/, "regex"]]]';
const files=()=>new Map([
  ['a.mjs',`export const a = standalone([6,{x:${atom}, y:${atom}},1]);`],
  ['b.mjs',`export const b = standalone([6,{x:${atom}, y:${atom}},1]);`],
]);
it('interns repeated literal programs once across generated modules',()=>{
  const output=internProgramFiles(files());
  expect(output.has('programs.mjs')).toBe(true);
  expect([...output.values()].join('\n').split('/^synthetic_').length-1).toBe(1);
  expect(output.get('a.mjs')).toContain('__standalonePrograms[');
});
it('is deterministic and never changes source map inputs',()=>{
  const input=files(), before=new Map(input);
  expect(internProgramFiles(input)).toEqual(internProgramFiles(input)); expect(input).toEqual(before);
});
it('does not hoist callback bodies, lexical references, or their effectful expressions',()=>{
  const expression='(value) => [value, unknownHelper(), /^synthetic_[a-z2-7]{26}$/].length';
  const input=files(); input.set('c.mjs',`export const c = standalone([14, [0, []], ${expression}]);`);
  const result=internProgramFiles(input);
  expect(result.get('c.mjs')).toContain(expression);
  expect(result.get('programs.mjs')).not.toMatch(/unknownHelper|value/);
});
it('does not share enum option arrays exposed through validation errors or .options',()=>{
  const input=files();
  for(const name of ['c.mjs','d.mjs'])input.set(name,'export const c=standalone([6,{kind:[5,["alpha","beta","long_option"]]},1]);');
  expect(internProgramFiles(input).get('programs.mjs')).not.toContain('long_option');
});
