import { expect, it } from "vitest";
import ts from "typescript";
import { analyzeStoreProgram, assertStoreOmissions } from "../config/store-reachability.mjs";
function analyze(body) {
  const text = `class ClayStore { alive(){ return this.helper(); } helper(){ return 1; } unused(){ return 2; } }
    const store = new ClayStore(); ${body}`;
  const file = "store.ts", host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = name => name === file ? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) : undefined;
  host.fileExists = name => name === file; host.readFile = name => name === file ? text : undefined;
  const program = ts.createProgram([file], { noLib: true }, host);
  return analyzeStoreProgram(program, program.getSourceFile(file), new Set([file]));
}
it("follows direct, captured and finite-key calls including internal helpers", () => {
  const result = analyze('const invoke = ClayStore.prototype.alive; invoke.call(store);');
  expect(result.nodes.filter(n => n.reachable).map(n => n.name)).toEqual(expect.arrayContaining(["ClayStore.alive", "ClayStore.helper"]));
  expect(result.nodes.find(n => n.name === "ClayStore.unused").reachable).toBe(false);
  expect(analyze('store["alive"]();').nodes.find(n => n.name === "ClayStore.alive").reachable).toBe(true);
  expect(analyze('const commands = { run: ClayStore.prototype.alive }; commands.run.call(store);').escapes).toEqual([]);
});
it.each(['declare const key: string; store[key]();', 'Reflect.get(store, "alive")();',
  'const escaped: any = store; escaped.whatever();', 'declare function unknown(x: any): void; unknown(store);',
  'function leak(){ return store; }'])
  ("cannot authorize an omission through dynamic/reflection/alias escape: %s", body => {
    const result = analyze(body);
    expect(result.escapes.length).toBeGreaterThan(0);
    expect(() => assertStoreOmissions(result, ["ClayStore.unused"])).toThrow(/not closed/);
  });
it("refuses removal of any reachable method, even in a closed fixture", () => {
  expect(() => assertStoreOmissions(analyze('store.alive();'), ["ClayStore.alive"])).toThrow(/reachable/);
});
