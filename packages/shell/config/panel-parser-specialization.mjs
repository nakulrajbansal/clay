import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { minify } from "terser";

const require = createRequire(new URL("../../kernel/package.json", import.meta.url));
const parserFile = require.resolve("acorn").replace(/acorn\.js$/, "acorn.mjs");
const wrapperFile = fileURLToPath(new URL("../../kernel/src/panel-program.ts", import.meta.url));
const PINNED_HASH = "1cbcbf252a5800e496dc505c706f309a9dd4e1789392e12963c77ae9497ff6f7";
const WRAPPER_HASH = "54f2a1fced7f4932478a278c7ad7eb03507e06e6c281db49c98d91c2135379dd";
const fixed = Object.freeze({
  sourceType: "module", strict: false, allowReserved: false,
  allowReturnOutsideFunction: false, allowImportExportEverywhere: false,
  allowAwaitOutsideFunction: null, allowSuperOutsideMethod: null, allowHashBang: true,
  checkPrivateFields: true, locations: false, ranges: false, preserveParens: false,
  onInsertedSemicolon: null, onTrailingComma: null, onToken: null, onComment: null,
  program: null, sourceFile: null, directSourceFile: null,
});

/** Partial evaluation of the exact pinned parser for our two closed module
 * entry points. Grammar, Unicode tables, errors, private-name/scope checks,
 * regexp validation and AST construction are the ORIGINAL Acorn implementation.
 * There is no replacement scanner, grammar subset, eval or permissive fallback.
 * Only options that neither caller supplies and old-edition branches unreachable
 * in BOTH 2023 and latest are constant-folded. Upstream drift fails the build. */
export function specializePanelParser(source) {
  if (createHash("sha256").update(source).digest("hex") !== PINNED_HASH)
    throw new Error("panel parser specialization requires pinned Acorn 8.17.0 bytes");
  const ast = ts.createSourceFile(parserFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function option(node) {
    if (!ts.isPropertyAccessExpression(node)) return null;
    const object = node.expression;
    if ((ts.isIdentifier(object) && object.text === "options")
        || (ts.isPropertyAccessExpression(object) && object.name.text === "options"
          && (object.expression.kind === ts.SyntaxKind.ThisKeyword
            || (ts.isIdentifier(object.expression) && object.expression.text === "parser"))))
      return node.name.text;
    return null;
  }
  function replace(node, text) { edits.push({ start: node.getStart(ast), end: node.end, text }); }
  function visit(node) {
    // The parser object/plugin/reflection APIs never leave panel-program.ts.
    // Retaining Parser.acorn also retains every unused public helper/options map.
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.left)
        && ts.isIdentifier(node.expression.left.expression)
        && node.expression.left.expression.text === "Parser"
        && ["acorn", "extend", "parseExpressionAt", "tokenizer"].includes(node.expression.left.name.text)) {
      replace(node, ""); return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "getOptions") {
      replace(node, 'function getOptions(opts) { return { ecmaVersion: opts.ecmaVersion === 2023 ? 14 : 1e8 }; }');
      return;
    }
    if (ts.isBinaryExpression(node) && option(node.left) === "ecmaVersion" && ts.isNumericLiteral(node.right)) {
      const right = Number(node.right.text), operator = node.operatorToken.kind;
      const evaluate = left => {
        switch (operator) {
          case ts.SyntaxKind.LessThanToken: return left < right;
          case ts.SyntaxKind.LessThanEqualsToken: return left <= right;
          case ts.SyntaxKind.GreaterThanToken: return left > right;
          case ts.SyntaxKind.GreaterThanEqualsToken: return left >= right;
          case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
          case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
          default: return undefined;
        }
      };
      const first = evaluate(14), latest = evaluate(1e8);
      if (first !== undefined && first === latest) { replace(node, String(first)); return; }
    }
    const name = option(node);
    if (name && Object.hasOwn(fixed, name)) { replace(node, JSON.stringify(fixed[name])); return; }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

export function createPanelParserSpecialization() {
  const normalize = file => file.replaceAll("\\", "/");
  let loaded = false;
  return {
    name: "clay-closed-panel-parser", apply: "build", enforce: "pre",
    resolveId(id, importer) {
      if (id !== "acorn") return;
      if (!importer || normalize(importer) !== normalize(wrapperFile))
        throw new Error("production Acorn imports must use the closed panel-program entry points");
      if (createHash("sha256").update(readFileSync(wrapperFile, "utf8").replaceAll("\r\n", "\n"))
        .digest("hex") !== WRAPPER_HASH)
        throw new Error("panel-program options changed; revalidate the parser specialization first");
      return normalize(parserFile);
    },
    async load(id) {
      if (normalize(id) !== normalize(parserFile)) return;
      loaded = true;
      const source = specializePanelParser(readFileSync(parserFile, "utf8"));
      const ast = ts.createSourceFile(parserFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const methods = [];
      // Only pinned Parser.prototype methods are private to this compilation.
      // Never mangle AST fields, syntax strings, errors, or other Clay properties.
      for (const statement of ast.statements) {
        const expression = ts.isExpressionStatement(statement) ? statement.expression : null;
        const left = expression && ts.isBinaryExpression(expression) ? expression.left : null;
        if (left && ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)
            && /^pp(?:\$\d+)?$/.test(left.expression.text)) methods.push(left.name.text);
      }
      const result = await minify(source, { module: true, compress: { passes: 2 },
        mangle: { properties: { regex: new RegExp(`^(?:${methods.join("|")})$`) } } });
      if (!result.code) throw new Error("closed panel parser compilation returned no code");
      return result.code;
    },
    generateBundle() {
      const info = this.getModuleInfo(normalize(parserFile));
      if (loaded && !info) throw new Error("closed panel parser module identity is missing");
      if (info && (info.importers.some(id => normalize(id) !== normalize(wrapperFile))
          || info.dynamicImporters.length))
        throw new Error("alternate Acorn import bypassed the closed panel-program boundary");
    },
  };
}
