import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { createPanelParserSpecialization, specializePanelParser } from "../config/panel-parser-specialization.mjs";
import { SEED_PANELS } from "../src/shells/seed-panels";
import { validateMutationPlan, FORBIDDEN_IDENTIFIERS } from "../../kernel/src/validate";
import { renamePanelFieldReferences } from "../../kernel/src/panel-rewrite";

const require = createRequire(new URL("../../kernel/package.json", import.meta.url));
const { parse } = require("acorn");
const entry = fileURLToPath(new URL("./fixtures/compiled-panel-validation.ts", import.meta.url));
function outcome(parseProgram, code, version) {
  try {
    const ast = parseProgram(code, version);
    return JSON.stringify(ast, (_key, value) => {
      if (typeof value === "bigint") return { bigint: String(value) };
      if (Object.prototype.toString.call(value) === "[object RegExp]") return { regex: String(value) };
      return value;
    });
  } catch (error) {
    return { name: error.name, message: error.message, pos: error.pos,
      raisedAt: error.raisedAt, loc: error.loc && { line: error.loc.line, column: error.loc.column } };
  }
}

describe("closed production panel parser", () => {
  it("rejects upstream drift and alternate option/API callers", () => {
    expect(() => specializePanelParser("changed dependency")).toThrow(/pinned Acorn/);
    const plugin = createPanelParserSpecialization();
    expect(() => plugin.resolveId("acorn", "/unexpected-caller.ts")).toThrow(/closed panel-program/);
    expect(() => plugin.generateBundle.call({ getModuleInfo: () => ({
      importers: ["/direct-path-bypass.ts"], dynamicImporters: [],
    }) })).toThrow(/alternate Acorn import/);
  });
  it("rejects a real build that imports the dependency by absolute path instead of the closed wrapper", async () => {
    const dependency = require.resolve("acorn").replace(/acorn\.js$/, "acorn.mjs").replaceAll("\\", "/");
    await expect(build({ configFile: false, logLevel: "silent", plugins: [
      { name: "owned-direct-import-fixture", resolveId(id) { if (id === "owned-bypass") return id; },
        load(id) { if (id === "owned-bypass") return `import {parse} from ${JSON.stringify(dependency)}; export default parse;`; } },
      createPanelParserSpecialization(),
    ], build: { write: false, minify: false,
      rollupOptions: { input: "owned-bypass", preserveEntrySignatures: "strict" } } }))
      .rejects.toThrow(/alternate Acorn import/);
  });
  it("removes only unused parser options/old-edition branches, preserving both real grammars and exact errors", async () => {
    const built = await build({ configFile: false, logLevel: "silent",
      plugins: [createPanelParserSpecialization()], build: { write: false, minify: "terser",
        lib: { entry, name: "OwnedPanelParser", formats: ["iife"] } } });
    const code = (Array.isArray(built) ? built[0] : built).output.find(file => file.type === "chunk").code;
    // An executable code-membership test, not a changed release budget.
    expect(code.includes("onInsertedSemicolon")).toBe(false);
    expect(code.includes("allowImportExportEverywhere")).toBe(false);
    const context = vm.createContext({});
    vm.runInContext(code, context);
    const actual = (source, version) => version === 2023
      ? context.OwnedPanelParser.parseValidatedPanel(source)
      : context.OwnedPanelParser.parseRewritablePanel(source);
    const reference = (source, version) => parse(source, { ecmaVersion: version, sourceType: "module" });
    const corpus = [
      ...Object.values(SEED_PANELS).flat().map(panel => panel.code),
      "", "export default function (clay) {}", "export default clay => clay.ui.render(null)",
      "#!/usr/bin/env node\nexport default function(clay){return /[a-z]+/giu.test('value')}",
      "export default async function(clay){await clay.db.query({from:'items'});}",
      "export default function(clay){const x = row?.value ?? 1; return `a${x}b`;}",
      "export default function(clay){class A{#x=1; get(){return this.#x}}; return new A;}",
      "export default function(clay){class A{get(){return this.#missing}}}",
      "export default function(clay){return /(?<word>a)\\k<word>/u}",
      "export default function(clay){return /[a&&b]/v}",
      "export default function(clay){return /[a-/u}",
      "export default function(clay){const \u{10400}=1n; return \u{10400};}",
      "import value from 'other'; export default function(clay){}",
      "import value from 'other' with { type: 'json' }; export default function(clay){}",
      "export default function(clay){using value = resource;}",
      "return 1", "await task()", "const await = 1", "export default function(a,a){}",
      "export default function(clay){with(object){}}", "export default function(clay){super.x}",
      "export default function(clay){return import('other')}", "export default function(clay){return import.meta}",
      "/* comment */\nexport default function(clay){return 'unterminated}",
      "export default function(clay){return `\\unicode`} ",
      "export default function(clay){return tag`\\unicode`} ",
      "export default function(clay){return {parseExpression:1,readWord:2,startNode:3,raise:4}}",
      `export default function(clay){return ${JSON.stringify("x".repeat(4097))}}`,
      `export default function(clay){return ${"!".repeat(45)}true}`,
    ];
    for (const name of FORBIDDEN_IDENTIFIERS) {
      corpus.push(`export default function(clay){${name};}`);
      corpus.push(`export default function(clay){clay[${JSON.stringify(name)}];}`);
    }
    // Deterministic grammar combinations and syntax faults (not a model corpus).
    for (const lhs of ["row.value", "row['value']", "row?.value", "record.value", "({value:1}).value"])
      for (const rhs of ["1", "-1", "1n", "'value'", "`value`", "[1,,2]", "{value:1}", "/a/u"])
        for (const suffix of [";", "", "; /*value*/", "; return (", "; const x = ;"])
          corpus.push(`export default function(clay){const value=${rhs}; clay.db.update('items','id',{value}); ${lhs}${suffix}}`);
    for (const version of [2023, "latest"])
      for (const source of corpus) expect(outcome(actual, source, version), `${version}: ${source}`)
        .toEqual(outcome(reference, source, version));
    const ctx = { registry: new Map([["items", { name: "items", columns: [
      { name: "value", type: "text", required: false },
    ] }]]), livePanelIds: [] };
    for (const code of corpus) {
      const plan = { api: 1, summary: "Owned parser fixture", assumptions: [], migration: null,
        clarifying_question: null, confidence: 1, remove_panels: [],
        user_facing_diff: [{ kind: "add_panel", detail: "Owned panel" }],
        panels: [{ panel_id: "owned", title: "Owned", placement: { region: "main", order: 0 },
          code, declared_queries: [{ from: "items" }], declared_writes: ["items"] }] };
      expect(context.OwnedPanelParser.validateMutationPlan(plan, ctx))
        .toEqual(validateMutationPlan(plan, ctx));
      expect(outcome(source => context.OwnedPanelParser.renamePanelFieldReferences(source, "value", "renamed"), code))
        .toEqual(outcome(source => renamePanelFieldReferences(source, "value", "renamed"), code));
    }
  });
});
