import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "../packages/shell/node_modules/typescript/lib/typescript.js";

const selfManifest = "evidence/p0-verification/review.json";
function assertReviewPath(path) {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".")
      || /(?:^|\/)(?:\.env|credentials|secrets)(?:[./]|$)/i.test(path))
    throw new Error("unsafe or sensitive review path refused");
}

export async function collectReviewFiles(root, changedPaths) {
  const paths = new Set(changedPaths);
  async function walk(directory) {
    let entries;
    try { entries = await readdir(join(root, directory), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("unbound evidence symlink refused");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.add(path);
    }
  }
  // These directories are exclusively produced by the owned executable gates.
  // Include ignored logs/screenshots; do not crawl other user/evidence folders.
  for (const directory of ["evidence/p0-verification", "evidence/p0-multi-app-ui"]) await walk(directory);
  const files = {};
  for (const path of [...paths].sort()) {
    if (path === selfManifest) continue;
    assertReviewPath(path);
    const target = relative(resolve(root), await realpath(join(root, path)));
    if (target === ".." || target.startsWith("../") || target.startsWith("..\\") || isAbsolute(target))
      throw new Error("review path resolves outside the workspace");
    files[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
  }
  return files;
}

/** A conservative AST/pattern packet, not a substitute for contextual security review. */
export function scanReviewSource(path, source) {
  const findings = [];
  const credential = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{30,})/;
  source.split(/\r?\n/).forEach((line, index) => {
    if (credential.test(line)) findings.push({ path, line: index + 1, reason: "possible credential literal" });
  });
  if (!/\.(?:ts|tsx|mjs|js)$/.test(path)) return findings;
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (node, reason) => findings.push({ path, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, reason });
  const name = node => ts.isIdentifier(node) ? node.text
    : ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
  const subprocess = /child_process/.test(source);
  function visit(node) {
    if ((ts.isCallExpression(node) && name(node.expression) === "eval")
        || (ts.isNewExpression(node) && name(node.expression) === "Function")) add(node, "executable evaluation");
    if ((ts.isBinaryExpression(node) && name(node.left) === "innerHTML"
          && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        || (ts.isJsxAttribute(node) && node.name.getText(ast) === "dangerouslySetInnerHTML")
        || (ts.isPropertyAssignment(node) && node.name.getText(ast) === "dangerouslySetInnerHTML")) add(node, "unsafe HTML sink");
    if (node.kind === ts.SyntaxKind.DebuggerStatement) add(node, "debug breakpoint");
    if (subprocess && ts.isCallExpression(node) && ["exec", "execSync"].includes(name(node.expression))
        && node.arguments[0] && ts.isTemplateExpression(node.arguments[0])) add(node, "shell interpolation");
    if (subprocess && ts.isPropertyAssignment(node) && node.name.getText(ast) === "shell"
        && node.initializer.kind === ts.SyntaxKind.TrueKeyword) add(node, "implicit command shell");
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return findings;
}
