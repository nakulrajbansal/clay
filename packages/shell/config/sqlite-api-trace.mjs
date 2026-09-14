import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { splitSqliteDistribution } from "./shared-sqlite-runtime.mjs";

// Audit tooling only. This module is NOT a production plugin or a reachability
// optimizer. A conservative syntax inventory records indirect calls instead of
// pretending to resolve them. No section currently has an omission proof.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../kernel/package.json", import.meta.url));
const sdk = dirname(require.resolve("@sqlite.org/sqlite-wasm/package.json"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const lf = text => text.replaceAll("\r\n", "\n");
const pins = Object.freeze({
  package: "@sqlite.org/sqlite-wasm", version: "3.53.0-build1",
  index: "f80870f0fa03a39a3338d17ed3fbea04808d344c88e724d90d5f37b9b7b83154",
  worker: "060ec0274c112339c553e38c591d9e1220e67b738113d8868862e99e400bee2f",
  wasm: "02d7e48164395fa68f81c6ec33e9da5461be397dc57602ac0cd89b4bbba1d312",
});

// These are the SQLite-object consumers, their physical authority callers, and
// the owned fixture/certificate entry points. No manifest-supplied filesystem
// paths are read. The public DbDriver is an SQL abstraction, not a SQLite escape.
export const SQLITE_TRACE_PATHS = Object.freeze([
  "packages/kernel/package.json", "packages/shell/package.json", "pnpm-lock.yaml",
  "packages/kernel/src/db.ts",
  "packages/kernel/src/sahpool-initialization.ts", "packages/kernel/src/sahpool-journal-recovery.ts",
  "packages/kernel/src/native-recovery-shadow.ts", "packages/kernel/src/native-recovery-bounds.ts",
  "packages/kernel/src/production-native-recovery.ts", "packages/kernel/src/production-authority.ts",
  "packages/kernel/src/durable-inventory.ts", "packages/kernel/src/lifecycle-recovery-inventory.ts",
  "packages/kernel/src/production-automation-observer-routes.ts",
  "packages/kernel/src/production-mutation-coordinator.ts",
  "packages/shell/src/worker/db-worker.ts", "packages/shell/vite.config.ts",
  "packages/shell/config/shared-sqlite-runtime.mjs", "packages/shell/config/shared-runtime-chunks.mjs",
  "packages/shell/config/sqlite-api-trace.mjs", "scripts/sqlite-api-trace.mjs",
  "packages/kernel/test/helpers/owned-sahpool.ts", "packages/kernel/test/sahpool-initialization.test.ts",
  "packages/kernel/test/sahpool-recovery.test.ts", "packages/kernel/test/production-native-recovery.test.ts",
  "packages/kernel/test/production-authority.test.ts", "packages/shell/test/shared-sqlite-runtime.test.mjs",
  "packages/shell/test/sqlite-api-trace.test.mjs", "packages/shell/test/sqlite-initializer-oracle.test.mjs",
  "scripts/transaction-certificate/worker.ts", "scripts/transaction-certificate/run.mjs",
].sort());

// Bind the *whole* production source corpus as well as the explicit operational
// roots. Adding an import/alias/consumer outside those roots invalidates the
// checked trace. Enumerate only repo-owned source directories, never profiles,
// user databases or a manifest-controlled path. Symlinks fail closed.
function productionCorpus() {
  const corpus = [];
  for (const name of ["backend", "kernel", "mutation", "panel-runtime", "schema", "shell"]) {
    const rows = [];
    const visit = directory => {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        const path = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error("SQLite trace: unknown linked source input");
        if (entry.isDirectory()) visit(path);
        else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) rows.push({ path, sha256: hash(lf(readFileSync(join(root, path), "utf8"))) });
      }
    };
    visit(`packages/${name}/src`);
    corpus.push({ package: name, files: rows.length, pathsSha256: hash(JSON.stringify(rows.map(row => row.path))), sourceSha256: hash(JSON.stringify(rows)) });
  }
  return corpus;
}

export function loadSqliteTraceInputs() {
  const index = readFileSync(join(sdk, "dist/index.mjs"), "utf8");
  const worker = readFileSync(join(sdk, "dist/sqlite3-worker1.mjs"), "utf8");
  const split = splitSqliteDistribution(index, worker);
  return {
    packageJson: readFileSync(join(sdk, "package.json"), "utf8"), index, worker,
    wasm: readFileSync(join(sdk, "dist/sqlite3.wasm")), initializer: split.initializer,
    productionCorpus: productionCorpus(),
    parser: { version: ts.version, sha256: hash(readFileSync(fileURLToPath(new URL("../node_modules/typescript/lib/typescript.js", import.meta.url)))) },
    sources: SQLITE_TRACE_PATHS.map(path => ({ path, source: lf(readFileSync(join(root, path), "utf8")) })),
  };
}

function sourceFile(source, path = "initializer.mjs") {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true,
    path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error("SQLite trace: unsupported or malformed AST shape");
  return ast;
}
function member(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(node)) return `${member(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return `${member(node.expression)}[${key && ts.isStringLiteralLike(key) ? JSON.stringify(key.text) : "?"}]`;
  }
  return "<indirect>";
}
function walk(ast, visit) { visit(ast); ts.forEachChild(ast, child => walk(child, visit)); }

/** All sites, including aliases/constructors/reflective and callback edges.
 * This is deliberately a MAY-reach inventory, not a JS points-to analysis.
 * Computed accesses and indirect calls are unresolved and block specialization.
 * Detailed sites are regenerable; the checked manifest binds their full digest. */
export function sqliteSyntaxInventory(source, path) {
  const ast = sourceFile(source, path), sites = [], kinds = new Set();
  const record = (node, kind, detail) => sites.push({ start: node.getStart(ast), end: node.end, kind, detail });
  walk(ast, node => {
    kinds.add(ts.SyntaxKind[node.kind]);
    if (ts.isPropertyAccessExpression(node)) record(node, "member", member(node));
    if (ts.isElementAccessExpression(node)) record(node, "computed-access", member(node));
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      record(node, ts.isNewExpression(node) ? "construct" : "call", member(node.expression));
      for (const arg of node.arguments ?? [])
        if (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg) || ts.isIdentifier(arg)
            || ts.isPropertyAccessExpression(arg) || ts.isObjectLiteralExpression(arg))
          record(arg, "possible-callback-or-object-escape", member(arg));
    }
    if (ts.isVariableDeclaration(node) && node.initializer)
      record(node, "binding-or-alias", `${node.name.getText(ast)} <- ${member(node.initializer)}`);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      record(node, "write-or-alias", member(node.left));
    if (ts.isDeleteExpression(node)) record(node, "delete", member(node.expression));
    if (ts.isReturnStatement(node) && node.expression) record(node, "return-escape", member(node.expression));
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) record(node, "spread-escape", member(node.expression));
    if (ts.isForInStatement(node)) record(node, "reflective-enumeration", member(node.expression));
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      record(node, "function-or-callback", node.name?.getText(ast) ?? "<anonymous>");
  });
  const counts = Object.fromEntries([...new Set(sites.map(site => site.kind))].sort().map(kind => [kind, sites.filter(site => site.kind === kind).length]));
  return { astKinds: [...kinds].sort(), counts, siteSha256: hash(JSON.stringify(sites)), sites };
}

const registrationNames = ["version", "capi", "oo1", "worker1", "vfs", "vtab", "kvvfs", "opfs", "opfs-proxy", "sahpool", "opfs-wl"];
export function sqliteRegistrationSections(source) {
  const ast = sourceFile(source), result = [];
  walk(ast, node => {
    if (!ts.isCallExpression(node) || member(node.expression) !== "globalThis.sqlite3ApiBootstrap.initializers.push") return;
    if (node.arguments.length !== 1 || !ts.isFunctionExpression(node.arguments[0])
        || node.arguments[0].parameters.length !== 1 || node.arguments[0].parameters[0].name.getText(ast) !== "sqlite3"
        || !ts.isExpressionStatement(node.parent)) throw new Error("SQLite trace: unknown initializer registration shape");
    const start = node.parent.getStart(ast), end = node.parent.end;
    result.push({ id: registrationNames[result.length], start, end, sha256: hash(source.slice(start, end)) });
  });
  if (result.length !== registrationNames.length || result.some(row => !row.id))
    throw new Error("SQLite trace: unknown initializer registration cardinality");
  return result;
}

function summary(source, path) {
  const { sites, ...result } = sqliteSyntaxInventory(source, path);
  return { ...result, calls: [...new Set(sites.filter(site => site.kind === "call" || site.kind === "construct").map(site => site.detail))].sort() };
}

export function createSqliteApiTrace(inputs) {
  const pkg = JSON.parse(inputs.packageJson);
  if (pkg.name !== pins.package || pkg.version !== pins.version || hash(inputs.index) !== pins.index
      || hash(inputs.worker) !== pins.worker || hash(inputs.wasm) !== pins.wasm
      || inputs.initializer !== splitSqliteDistribution(inputs.index, inputs.worker).initializer)
    throw new Error("SQLite trace: pinned package/initializer/WASM drift; no specialization is authorized");
  if (JSON.stringify(inputs.sources.map(row => row.path)) !== JSON.stringify(SQLITE_TRACE_PATHS))
    throw new Error("SQLite trace: missing, duplicate or unknown trace inputs");
  const registrations = sqliteRegistrationSections(inputs.initializer);
  // A contiguous partition includes all non-registration code: Emscripten,
  // struct binder, bootstrap, async callbacks and the final initializer loop.
  const sections = []; let at = 0;
  for (const row of registrations) {
    if (at < row.start) sections.push({ id: `retained-before-${row.id}`, start: at, end: row.start });
    sections.push(row); at = row.end;
  }
  sections.push({ id: "retained-bootstrap-tail", start: at, end: inputs.initializer.length });
  return {
    format: "clay-sqlite-api-trace-v1", analysis: "conservative-syntax-inventory-not-an-omission-proof",
    pinned: { ...pins, packageSha256: hash(inputs.packageJson), initializerSha256: hash(inputs.initializer), parser: inputs.parser },
    productionCorpus: inputs.productionCorpus,
    inputs: inputs.sources.map(({ path, source }) => ({ path, sha256: hash(source), bytes: Buffer.byteLength(source) })),
    consumers: inputs.sources.filter(row => row.path.endsWith(".ts") && !row.path.includes("/test/")).map(({ path, source }) => ({ path, ...summary(source, path) })),
    initializer: summary(inputs.initializer, "initializer.mjs"),
    supportWorker: summary(inputs.worker, "sqlite3-worker1.mjs"),
    sections: sections.map(row => ({ ...row, sha256: hash(inputs.initializer.slice(row.start, row.end)), policy: "retain-intact" })),
    verdict: {
      kind: "SPECIALIZATION_BLOCKED", approvedOmissions: [],
      reasons: [
        "Every registered initializer is a bootstrap root, including callback installation and property deletion.",
        "Worker1 open forwards args.vfs into OO1; named-memory KVVFS uses JS callbacks into the unchanged WASM.",
        "Vtab adds public sqlite3_index_info prototype methods. Its KVVFS create_module consumer is conditional on __isUnderTest, not an unconditional production callback.",
        "Computed keys, reflective aliases, indirect callbacks and object escapes are retained unresolved, not auto-approved.",
      ],
    },
  };
}

export function generateSqliteInitializer(inputs, checked, request) {
  // Reject an unsupported policy before any expensive audit. There is no
  // omission-proof mode to evaluate, and getters must never run during capture.
  const keys = request && typeof request === "object" ? Reflect.ownKeys(request) : [];
  const kind = keys.length === 1 && keys[0] === "kind" ? Object.getOwnPropertyDescriptor(request, "kind") : undefined;
  if (!request || Object.getPrototypeOf(request) !== Object.prototype
      || !kind || !Object.hasOwn(kind, "value") || kind.value !== "retain-intact")
    throw new Error("SQLite omission not proven: reachable side effects and unresolved dynamic edges require the intact initializer");
  const actual = createSqliteApiTrace(inputs);
  if (JSON.stringify(actual) !== JSON.stringify(checked)) throw new Error("SQLite trace drift: checked API/section/input manifest does not match");
  return inputs.initializer;
}
