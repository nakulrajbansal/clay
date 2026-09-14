// Source inventory using the actual production module report. Not certification.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import ts from '../packages/schema/node_modules/typescript/lib/typescript.js';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function schemaProductionInventory() {
  const report=JSON.parse(await readFile(resolve(root,'test-results/fix-batch/bundle-modules.json'),'utf8'));
  if(report.kind!=='build_module_diagnostic_not_certification')throw new Error('Expected actual module report');
  const membership=new Map();
  for(const chunk of report.chunks)for(const module of chunk.modules)
    if(module.rendered&&module.id.startsWith('packages/')&&module.id.includes('/src/')&&!module.id.includes('?')) {
      if(!membership.has(module.id))membership.set(module.id,new Set());membership.get(module.id).add(chunk.runtime);
    }
  const imports=[],factories=[];
  for(const [file,realms]of membership) {
    const original=await readFile(resolve(root,file),'utf8');
    const source=ts.transpileModule(original,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    function visit(node) {
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) {
        const module=node.moduleSpecifier?.text;
        if(module?.startsWith('@clay/schema')) imports.push({file,realms:[...realms],module,kind:'static',names:
          node.importClause?.namedBindings?.elements?.map(n=>n.propertyName?.text??n.name.text)??['*']});
      }
      if(ts.isCallExpression(node)) {
        if(node.expression.kind===ts.SyntaxKind.ImportKeyword&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text.startsWith('@clay/schema'))
          imports.push({file,realms:[...realms],module:node.arguments[0].text,kind:'dynamic',names:['*']});
        if(ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(ast)==='z')
          factories.push({file,method:node.expression.name.text,expression:node.getText(ast)});
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  const policies=new Set(['refine','superRefine','default','transform','preprocess','lazy','custom','min','max','length',
    'regex','datetime','uuid','url','finite','safe','int','trim','strict','strip','passthrough','nullable','optional',
    'nonnegative','positive','record','array','object','discriminatedUnion','union','literal','enum']);
  const approved=JSON.parse(await readFile(resolve(root,'packages/schema/scripts/standalone-approved.json'),'utf8'));
  const contracts=[];
  for(const [file,sourceSha256]of Object.entries(approved))if(/^packages\/schema\/src\/[a-z-]+\.ts$/.test(file)&&!file.endsWith('/validation-runtime.ts')) {
    const source=await readFile(resolve(root,file),'utf8'), digest=text=>createHash('sha256').update(text).digest('hex');
    if(digest(source)!==sourceSha256)throw new Error('Unapproved contract input in inventory');
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true), declarations=[];
    for(const statement of ast.statements) {
      const definitions=ts.isVariableStatement(statement)?[...statement.declarationList.declarations]
        :ts.isFunctionDeclaration(statement)?[statement]:[];
      for(const definition of definitions) {
        const checks=[];
        function visit(node) {
          if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&policies.has(node.expression.name.text))
            checks.push({method:node.expression.name.text,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,
              sourceSha256:digest(node.getText(ast)),arguments:node.arguments.map(arg=>ts.isArrowFunction(arg)||ts.isFunctionExpression(arg)
                ?{functionSha256:digest(arg.getText(ast))}:arg.getText(ast))});
          ts.forEachChild(node,visit);
        }
        visit(definition);
        declarations.push({name:definition.name.getText(ast),sourceSha256:digest(definition.getText(ast)),checks});
      }
    }
    const generated=file.replace('/src/','/src/standalone/').replace(/\.ts$/,'.mjs');
    contracts.push({file,sourceSha256,generated,generatedSha256:digest(await readFile(resolve(root,generated),'utf8')),declarations});
  }
  return {kind:'schema_production_source_inventory_not_certification',imports,factories,contracts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const inventory=await schemaProductionInventory();
  if(process.argv.includes('--output')) {
    const directory=resolve(root,'test-results/fix-batch');await mkdir(directory,{recursive:true});
    await writeFile(resolve(directory,'schema-production-inventory.json'),JSON.stringify(inventory,null,2));
    console.log(JSON.stringify({kind:inventory.kind,imports:inventory.imports.length,factories:inventory.factories.length,
      contracts:inventory.contracts.length,output:'test-results/fix-batch/schema-production-inventory.json'}));
  } else console.log(JSON.stringify(inventory,null,2));
}
