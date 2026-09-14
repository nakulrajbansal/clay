import ts from "typescript";

const normalize = name => name.replaceAll("\\", "/").replace(/^.*?(?=packages\/)/, "");
/** Conservative, declaration-resolved method/helper graph. An escape is never
 * interpreted as an unused method. This is not a points-to/authority proof. */
export function analyzeStoreProgram(program, storeFile, inputFiles) {
  const checker = program.getTypeChecker();
  const klass = storeFile?.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === "ClayStore");
  if (!klass) throw new Error("Missing closed Store class");
  const declarations = new Map(), nodes = new Map();
  const implementations = new Set();
  const add = (name, declaration) => {
    if (declaration.body) {
      if (implementations.has(name)) throw new Error("Duplicate Store graph implementation");
      implementations.add(name);
    }
    declarations.set(declaration, name);
    const prior = nodes.get(name);
    const sourceBytes = Buffer.byteLength(declaration.getText(storeFile));
    if (prior) prior.sourceBytes += sourceBytes;
    else nodes.set(name, { name, sourceBytes, roots: new Set(), calls: new Set() });
  };
  for (const member of klass.members) {
    if (ts.isMethodDeclaration(member)) {
      if (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name)) throw new Error("Unsupported Store member name");
      add(`ClayStore.${member.name.text}`, member);
    } else if (ts.isConstructorDeclaration(member)) add("ClayStore.constructor", member);
    else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) throw new Error("Unsupported Store accessor");
  }
  for (const node of storeFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) add(`helper.${node.name.text}`, node);
    if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
      if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
        if (!ts.isIdentifier(d.name)) throw new Error("Unsupported Store helper binding");
        add(`helper.${d.name.text}`, d.initializer);
      }
  }
  const symbolNodes = symbol => (symbol?.declarations ?? []).flatMap(d => declarations.has(d) ? [declarations.get(d)] : []);
  const typeHasStore = node => checker.getTypeAtLocation(node).getProperties()
    .some(symbol => symbolNodes(symbol).some(name => name.startsWith("ClayStore.")));
  const literalKeys = node => {
    const type = checker.getTypeAtLocation(node), variants = type.isUnion() ? type.types : [type];
    return variants.length <= 256 && variants.every(t => t.isStringLiteral()) ? variants.map(t => t.value) : null;
  };
  function targets(expression, seen = new Set()) {
    if (seen.size > 32 || seen.has(expression)) return [];
    seen.add(expression);
    if (ts.isParenthesizedExpression(expression)) return targets(expression.expression, seen);
    if (ts.isPropertyAccessExpression(expression) && ["bind", "call", "apply"].includes(expression.name.text))
      return targets(expression.expression, seen);
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const direct = symbolNodes(symbol); if (direct.length) return direct;
    for (const declaration of symbol?.declarations ?? [])
      if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer) {
        if (declarations.has(declaration.initializer)) return [declarations.get(declaration.initializer)];
        return targets(declaration.initializer, seen);
      }
    return [];
  }
  const escapes = new Map();
  const at = (file, node) => `${normalize(file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const block = (file, node, kind) => escapes.set(`${at(file, node)}:${kind}`, { at: at(file, node), kind });
  for (const file of program.getSourceFiles()) {
    if (!inputFiles.has(normalize(file.fileName))) continue;
    function visit(node, owner = null) {
      if (declarations.has(node)) owner = declarations.get(node);
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      const edge = name => owner ? nodes.get(owner).calls.add(name) : nodes.get(name).roots.add(at(file, node));
      if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node))
        for (const name of targets(node)) edge(name);
      if (ts.isNewExpression(node) && node.expression.getText(file) === "ClayStore" && nodes.has("ClayStore.constructor")) edge("ClayStore.constructor");
      if (ts.isElementAccessExpression(node) && typeHasStore(node.expression)) {
        const keys = node.argumentExpression && literalKeys(node.argumentExpression);
        if (!keys) block(file, node, "dynamic_property_escape");
        else for (const key of keys) {
          const names = symbolNodes(checker.getTypeAtLocation(node.expression).getProperty(key));
          if (!names.length) block(file, node, "unknown_property");
          else names.forEach(edge);
        }
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (typeHasStore(node.expression) && !typeHasStore(node)) block(file, node, "erased_alias");
      }
      if (ts.isVariableDeclaration(node) && node.initializer && typeHasStore(node.initializer)
          && !typeHasStore(node.name)) block(file, node, "erased_alias");
      if (ts.isReturnStatement(node) && node.expression && typeHasStore(node.expression)) block(file, node, "returned_store_capability");
      if (ts.isPropertyAssignment(node) && typeHasStore(node.initializer)) block(file, node, "stored_capability_alias");
      if (ts.isCallExpression(node) && node.arguments.some(typeHasStore)) {
        const expression = node.expression;
        if (ts.isPropertyAccessExpression(expression) && ["Reflect", "Object"].includes(expression.expression.getText(file)))
          block(file, node, "reflection");
        else if (!targets(expression).length) {
          const declaration = checker.getResolvedSignature(node)?.declaration;
          if (!declaration?.body || !inputFiles.has(normalize(declaration.getSourceFile().fileName)))
            block(file, node, "unresolved_callable_alias");
        }
      }
      ts.forEachChild(node, child => visit(child, owner));
    }
    visit(file);
  }
  const reachable = new Set([...nodes.values()].filter(n => n.roots.size).map(n => n.name));
  for (const name of reachable) for (const next of nodes.get(name).calls) reachable.add(next);
  return { kind: "conservative_store_reference_graph_v1", escapes: [...escapes.values()],
    nodes: [...nodes.values()].map(n => ({ ...n, roots: [...n.roots].sort(), calls: [...n.calls].sort(), reachable: reachable.has(n.name) })) };
}
export function assertStoreOmissions(graph, names) {
  if (graph.escapes.length) throw new Error("Store reference graph is not closed; no omission authorized");
  for (const name of names) {
    const node = graph.nodes.find(n => n.name === name);
    if (!node || node.reachable) throw new Error(`Unknown or reachable Store operation: ${name}`);
  }
}
