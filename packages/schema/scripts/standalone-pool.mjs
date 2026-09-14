// Build-time only. Pool only inert, repeated parse-program literals. Never
// inspect/hoist a callback body, imported schema reference, call or getter.
import ts from "../node_modules/typescript/lib/typescript.js";

const exposedEnum = node => ts.isArrayLiteralExpression(node) && node.elements.length === 2
  && ts.isNumericLiteral(node.elements[0]) && node.elements[0].text === '5'
  && ts.isArrayLiteralExpression(node.elements[1]) && node.elements[1].elements.every(ts.isStringLiteral);
function pure(node) {
  if (exposedEnum(node)) return false;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)
      || [ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isIdentifier(node)) return node.text === "undefined";
  // Stateful patterns retain their original allocation; no cross-schema state.
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return !/[gy]/.test(node.text.slice(node.text.lastIndexOf('/')+1));
  if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(pure);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every(property => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name)||ts.isStringLiteral(property.name)||ts.isNumericLiteral(property.name)
      ||ts.isComputedPropertyName(property.name)&&ts.isStringLiteral(property.name.expression)) && pure(property.initializer));
  return false;
}
function walk(node, visitor) {
  if (ts.isFunctionLike(node) || exposedEnum(node)) return;
  if (visitor(node) === false) return;
  ts.forEachChild(node, child => walk(child, visitor));
}
function programs(file, visitor) {
  walk(file, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "standalone") {
      walk(node.arguments[0], visitor); return false;
    }
  });
}
function rewrite(source, edits, offset=0) {
  for(const [start,end,value]of edits.sort((a,b)=>b[0]-a[0]))
    source=source.slice(0,start-offset)+value+source.slice(end-offset);
  return source;
}
export function internProgramFiles(files) {
  const asts=new Map(), occurrences=new Map();
  for(const [name,source]of files)if(name.endsWith('.mjs')) {
    const file=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);asts.set(name,file);
    if(source.includes('__standalonePrograms'))throw new Error('Reserved standalone pool binding');
    programs(file,node=>{
      if(!pure(node)||!(ts.isArrayLiteralExpression(node)||ts.isObjectLiteralExpression(node)||node.kind===ts.SyntaxKind.RegularExpressionLiteral))return;
      const key=node.getText(file);if(key.length<28)return;
      const current=occurrences.get(key);
      if(current)current.count++;else occurrences.set(key,{node,file,count:1});
    });
  }
  const selected=new Map([...occurrences].filter(([key,item])=>(item.count-1)*key.length>item.count*12+20));
  const roots=new Map(), output=new Map(files);
  for(const [name,file]of asts) {
    const edits=[];
    programs(file,node=>{
      const key=node.getText(file);if(!selected.has(key))return;
      if(!roots.has(key))roots.set(key,roots.size);
      edits.push([node.getStart(file),node.end,`__standalonePrograms[${roots.get(key)}]`]);return false;
    });
    if(edits.length)output.set(name,`import {programs as __standalonePrograms} from './programs.mjs';\n${rewrite(files.get(name),edits)}`);
  }
  const definitions=[], names=new Map();
  function define(key) {
    if(names.has(key))return names.get(key);
    const {node,file}=selected.get(key),edits=[];
    ts.forEachChild(node,child=>walk(child,nested=>{
      const childKey=nested.getText(file);if(!selected.has(childKey))return;
      edits.push([nested.getStart(file),nested.end,define(childKey)]);return false;
    }));
    const alias=`p${definitions.length}`;
    definitions.push(`const ${alias}=${rewrite(key,edits,node.getStart(file))};`);names.set(key,alias);return alias;
  }
  const exports=[...roots.keys()].map(define);
  output.set('programs.mjs',`// Generated closed literal pool; no functions, imported capabilities or runtime generation.\n${definitions.join('\n')}\nexport const programs=[${exports.join(',')}];\n`);
  output.set('programs.d.mts','// Generated private program data, not a worker command contract.\nexport declare const programs: readonly unknown[];\n');
  return output;
}
