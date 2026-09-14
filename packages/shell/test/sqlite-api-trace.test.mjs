import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../config/sqlite-api-trace.mjs", import.meta.url);
const manifestUrl = new URL("../config/sqlite-api-trace.json", import.meta.url);
const traceModule = () => import(moduleUrl.href);

describe("closed pinned SQLite initialization trace", () => {
  it("requires a checked trace and an executable generator before specialization", () => {
    expect(existsSync(moduleUrl)).toBe(true);
    expect(existsSync(manifestUrl)).toBe(true);
  });
  it("does not approve removal of KVVFS or vtab from absence of application string references", async () => {
    const { loadSqliteTraceInputs, generateSqliteInitializer } = await traceModule();
    const inputs = loadSqliteTraceInputs();
    const checked = JSON.parse(readFileSync(manifestUrl, "utf8"));
    for (const section of ["kvvfs", "vtab"])
      expect(() => generateSqliteInitializer(inputs, checked, { kind: "omit-sections", sections: [section] }))
        .toThrow(/reachable|side effect|unresolved|not proven/);
  });
  it("ties an intact output to checked package, WASM, section and consumer bytes", async () => {
    const { loadSqliteTraceInputs, createSqliteApiTrace, generateSqliteInitializer } = await traceModule();
    const inputs = loadSqliteTraceInputs();
    const checked = JSON.parse(readFileSync(manifestUrl, "utf8"));
    expect(createSqliteApiTrace(inputs)).toEqual(checked);
    const output = generateSqliteInitializer(inputs, checked, { kind: "retain-intact" });
    expect(inputs.initializer).toBe(output);
  });
  it.each(["index", "worker", "initializer", "wasm", "packageJson"])("rejects pinned %s drift before allowing any output", async field => {
    const { loadSqliteTraceInputs, generateSqliteInitializer } = await traceModule();
    const inputs = loadSqliteTraceInputs();
    const checked = JSON.parse(readFileSync(manifestUrl, "utf8"));
    if (field === "wasm") { inputs.wasm = inputs.wasm.slice(); inputs.wasm[8] ^= 1; }
    else if (field === "packageJson") inputs.packageJson = inputs.packageJson.replace('"3.53.0-build1"', '"3.53.0-build2"');
    else inputs[field] += "\n";
    expect(() => generateSqliteInitializer(inputs, checked, { kind: "retain-intact" })).toThrow(/drift|pinned/);
  });
  it.each(["db.ts", "sahpool-journal-recovery.ts", "worker.ts", "sqlite-api-trace.mjs"])("rejects changed consumer/generator %s, even when a new property has not been classified", async suffix => {
    const { loadSqliteTraceInputs, generateSqliteInitializer } = await traceModule();
    const inputs = loadSqliteTraceInputs();
    const checked = JSON.parse(readFileSync(manifestUrl, "utf8"));
    const source = inputs.sources.find(row => row.path.endsWith(`/${suffix}`));
    expect(source).toBeDefined();
    source.source += "\nconst unexpected = sqlite[unknownProperty];\n";
    expect(() => generateSqliteInitializer(inputs, checked, { kind: "retain-intact" })).toThrow(/drift/);
  });
  it.each(["missing", "duplicate", "unknown"])("rejects %s captured source inputs", async kind => {
    const { loadSqliteTraceInputs, generateSqliteInitializer } = await traceModule();
    const inputs = loadSqliteTraceInputs();
    const checked = JSON.parse(readFileSync(manifestUrl, "utf8"));
    if (kind === "missing") inputs.sources.pop();
    else if (kind === "duplicate") inputs.sources.push(inputs.sources[0]);
    else inputs.sources[0] = { path: "outside-workspace.ts", source: "" };
    expect(() => generateSqliteInitializer(inputs, checked, { kind: "retain-intact" })).toThrow(/trace inputs/);
  });
  it("binds unknown source files, the parser and the entire contiguous initializer, not just recognized API names", async () => {
    const { loadSqliteTraceInputs, generateSqliteInitializer } = await traceModule();
    const checked = JSON.parse(readFileSync(manifestUrl, "utf8"));
    for (const corrupt of [
      input => { input.productionCorpus[0].sourceSha256 = "0".repeat(64); },
      input => { input.parser.sha256 = "0".repeat(64); },
    ]) {
      const inputs = loadSqliteTraceInputs(); corrupt(inputs);
      expect(() => generateSqliteInitializer(inputs, checked, { kind: "retain-intact" })).toThrow(/drift/);
    }
    let at = 0;
    for (const section of checked.sections) {
      expect(section.start).toBe(at); expect(section.end).toBeGreaterThan(at);
      expect(section.policy).toBe("retain-intact"); at = section.end;
    }
    expect(at).toBe(loadSqliteTraceInputs().initializer.length);
  });
  it("rejects changed section verdicts and unsupported policy even if the caller edits its candidate inventory", async () => {
    const { loadSqliteTraceInputs, generateSqliteInitializer } = await traceModule();
    const inputs = loadSqliteTraceInputs();
    const checked = JSON.parse(readFileSync(manifestUrl, "utf8"));
    const forged = structuredClone(checked);
    forged.verdict.approvedOmissions = ["kvvfs"];
    expect(() => generateSqliteInitializer(inputs, forged, { kind: "retain-intact" })).toThrow(/drift/);
    for (const request of [{ kind: "optimize" }, { kind: "omit-sections", sections: [] },
      { kind: "retain-intact", approve: true }, { kind: "retain-intact", [Symbol("escape")]: true },
      Object.assign(Object.create(null), { kind: "retain-intact" })])
      expect(() => generateSqliteInitializer(inputs, checked, request)).toThrow(/not proven/);
    let invoked = false;
    const accessor = { get kind() { invoked = true; inputs.initializer = "unverified"; return "retain-intact"; } };
    expect(() => generateSqliteInitializer(inputs, checked, accessor)).toThrow(/not proven/);
    expect(invoked).toBe(false);
  });
  it("accounts for aliases, computed property access, constructors, callbacks, reflection and public side effects as unresolved", async () => {
    const { sqliteSyntaxInventory } = await traceModule();
    const source = `const alias = sqlite.capi; const { sqlite3_vfs: Constructor } = alias;
      const object = new Constructor(pointer); const callback = alias[key];
      Object.defineProperty(object, name, { get() { return callback; } });
      wasm.installFunction(callback, signature); sqlite.vtab = object;
      delete alias.hidden; for (const name in alias) receiver(alias[name]);`;
    const result = sqliteSyntaxInventory(source, "consumer.mjs");
    for (const kind of ["binding-or-alias", "computed-access", "construct", "possible-callback-or-object-escape",
      "write-or-alias", "delete", "reflective-enumeration", "return-escape", "function-or-callback"])
      expect(result.counts[kind]).toBeGreaterThan(0);
    expect(result.sites.some(site => site.detail === "Object.defineProperty")).toBe(true);
    expect(result).not.toHaveProperty("approvedOmissions");
  });
  it("rejects malformed ASTs and unknown registration cardinality/callback shapes", async () => {
    const { loadSqliteTraceInputs, sqliteSyntaxInventory, sqliteRegistrationSections } = await traceModule();
    expect(() => sqliteSyntaxInventory("const = ;", "bad.mjs")).toThrow(/AST/);
    const { initializer } = loadSqliteTraceInputs();
    const extra = "globalThis.sqlite3ApiBootstrap.initializers.push(function(sqlite3){});";
    expect(() => sqliteRegistrationSections(initializer + extra)).toThrow(/cardinality/);
    expect(() => sqliteRegistrationSections(initializer.replace("push(function(sqlite3)", "push((sqlite3) =>"))).toThrow(/shape/);
  });
});
