import ts from "../node_modules/typescript/lib/typescript.js";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { encodeSchema, assertApprovedSource, assertApprovedManifest, digest } from "./standalone-compiler.mjs";
import { internProgramFiles } from "./standalone-pool.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const schemaRoot = resolve(root, "packages/schema");
export const sourceModules = ["index", "archive", "backup", "catalog", "daily-home", "intake", "intake-workflow", "legacy-owner", "owner-witness", "projection", "restore", "share", "import-staging", "import", "private-metrics", "saved-views", "intake-state", "worker-contracts", "pure-compute"];
const approvedFile = resolve(schemaRoot, "scripts/standalone-approved.json");
const outputRoot = resolve(schemaRoot, "src/standalone");
const isSchema = value => value && typeof value === "object" && typeof value._def?.typeName === "string";
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText;
const sourceCode = code => ({ sourceCode: code });
const authoringCall = /\bz\.(object|string|number|array|record|enum|union|literal)\(/;
function literal(value) {
  if (value?.sourceCode !== undefined) return value.sourceCode;
  if (value === undefined) return "undefined";
  if (Object.is(value, -0)) return "-0";
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Unsupported non-finite generated literal");
  if (value instanceof RegExp) return value.toString();
  if (typeof value === "function") throw new Error("Unapproved executable schema value");
  if (Array.isArray(value)) {
    let length=value.length; while(length&&value[length-1]===undefined)length--;
    return `[${value.slice(0,length).map(literal).join(",")}]`;
  }
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, child]) => `${key==='__proto__'?'["__proto__"]':JSON.stringify(key)}:${literal(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
const namesOf = file => file.statements.filter(ts.isVariableStatement).flatMap(s =>
  s.declarationList.declarations.map(d => { if (!ts.isIdentifier(d.name)) throw new Error("Unsupported schema binding"); return d.name.text; }));
const exported = node => !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const hookMethods = new Set(["refine", "superRefine", "default", "lazy", "extract", "transform", "custom", "preprocess"]);

function pureConstruction(source) {
  const file=ts.createSourceFile('generated.mjs',source,ts.ScriptTarget.Latest,true), edits=[];
  function visit(node) {
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='standalone') {
      // The initializer includes imported literal-pool accesses. Marking only
      // the inner call lets esbuild retain those accesses (and their graphs).
      // As with the original authoring IIFEs, the whole construction is inert;
      // actual parse/safeParse calls are never marked pure.
      edits.push([node.getStart(file),node.end,`/*#__PURE__*/ (()=>${node.getText(file)})()`]);return;
    }
    ts.forEachChild(node,visit);
  }
  visit(file);
  for(const [start,end,text]of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+text+source.slice(end);
  return source;
}

export async function generateStandalone({ check = false } = {}) {
  const approved = JSON.parse(await readFile(approvedFile, "utf8"));
  const dependencyRoot='node_modules/.pnpm/zod@3.25.76/node_modules/zod/';
  assertApprovedManifest(approved,[...sourceModules.map(name=>`packages/schema/src/${name}.ts`),
    'packages/schema/src/validation-runtime.ts', ...['package.json','index.js','v3/index.js','v3/external.js',
      'v3/errors.js','v3/types.js','v3/ZodError.js','v3/locales/en.js','v3/helpers/parseUtil.js',
      'v3/helpers/util.js','v3/helpers/errorUtil.js','v3/helpers/typeAliases.js'].map(name=>dependencyRoot+name)]);
  if(await realpath(createRequire(import.meta.url).resolve('zod/package.json'))
      !==await realpath(resolve(root,dependencyRoot+'package.json')))
    throw new Error('Unexpected standalone oracle dependency identity');
  const sources = new Map(); const asts = new Map(); const hookSources = new Map(); const inlines = new Map();
  for (const [file, hash] of Object.entries(approved)) {
    const bytes = await readFile(resolve(root, file), "utf8");
    assertApprovedSource(file, bytes, { [file]: hash });
  }
  for (const name of sourceModules) {
    const file = `packages/schema/src/${name}.ts`; const source = await readFile(resolve(root, file), "utf8");
    assertApprovedSource(file, source, approved);
    sources.set(name, source); asts.set(name, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  }
  const esbuild = createRequire(await realpath(resolve(root, "packages/shell/node_modules/vite/package.json")))("esbuild");
  const oracleZod = pathToFileURL(await realpath(resolve(schemaRoot, "node_modules/zod/index.js"))).href;
  const cache = resolve(root, "node_modules/.cache/clay-standalone"); await mkdir(cache, { recursive: true });
  const oracleFile = resolve(cache, "oracle.mjs");
  await esbuild.build({ stdin: { contents: sourceModules.map((name, i) => `import * as m${i} from ${JSON.stringify(resolve(schemaRoot, `src/${name}.ts`))};`).join("\n")
    + `\nimport { hooks } from 'clay:standalone-hooks'; export { hooks }; export const modules = {${sourceModules.map((n,i)=>`${JSON.stringify(n)}:m${i}`).join(",")}};`,
    resolveDir: schemaRoot, loader: "ts" }, outfile: oracleFile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "source-pinned-schema-oracle", setup(build) {
      build.onResolve({ filter: /^zod$/ }, () => ({ path: oracleZod, external: true }));
      build.onResolve({ filter: /^clay:standalone-hooks$/ }, () => ({ path: "hooks", namespace: "standalone" }));
      build.onLoad({ filter: /.*/, namespace: "standalone" }, () => ({ contents: `export const hooks = new Map(); export function record(schema,id) { hooks.set(schema,id); return schema; }`, loader: "js" }));
      build.onLoad({ filter: /packages[\\/]schema[\\/]src[\\/][^\\/]+\.ts$/ }, args => {
        const name = args.path.split(/[\\/]/).at(-1).slice(0,-3);
        if (!asts.has(name)) return;
        const source = sources.get(name); const file = asts.get(name); const edits = []; const inline = new Map(); inlines.set(name, inline);
        function visit(node) {
          if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='safeParse'
            &&authoringCall.test(node.expression.expression.getText(file))) {
            const body=node.expression.expression;
            // The three pinned workflow-local validators refer only to this
            // imported schema, never to a callback-local value or dynamic code.
            function checkFree(n) {
              if(ts.isIdentifier(n) && !['z','IntakeFormId'].includes(n.text)
                && !(ts.isPropertyAccessExpression(n.parent)&&n.parent.name===n)
                && !(ts.isPropertyAssignment(n.parent)&&n.parent.name===n))
                throw new Error(`Unsupported inline validator capture: ${name}/${n.text}`);
              ts.forEachChild(n,checkFree);
            }
            checkFree(body);
            const text=body.getText(file); if(!inline.has(text))inline.set(text,`__inline${inline.size}`);
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && hookMethods.has(node.expression.name.text)) {
            const kind = node.expression.name.text;
            if (["transform", "preprocess"].includes(kind)||kind==='custom'&&name!=='import') throw new Error(`Unsupported schema hook: ${name}/${kind}`);
            const id = `${name}:${node.getStart(file)}:${node.end}:${kind}`;
            if (kind === "default" && ![ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.ArrayLiteralExpression].includes(node.arguments[0]?.kind))
              throw new Error(`Unsupported schema default: ${id}`);
            if (kind === "default" && ts.isArrayLiteralExpression(node.arguments[0]) && node.arguments[0].elements.length !== 0)
              throw new Error(`Unsupported schema default: ${id}`);
            if (kind === "lazy" && name !== "index") throw new Error(`Unsupported lazy recursion: ${id}`);
            hookSources.set(id, { name, kind, callback: node.arguments[0]?.getText(file), message: node.arguments[1]?.getText(file) });
            edits.push({ start: node.getStart(file), end: node.end, id });
          }
          ts.forEachChild(node, visit);
        }
        visit(file);
        // Insertion-only annotation preserves nested expressions and exact source.
        const insertions = [];
        for (const e of edits) { insertions.push([e.start, "__record("]); insertions.push([e.end, `,${JSON.stringify(e.id)})`]); }
        insertions.sort((a,b)=>b[0]-a[0]); let transformed=source;
        for(const [at, text] of insertions) transformed=transformed.slice(0,at)+text+transformed.slice(at);
        return { contents: `import {record as __record} from 'clay:standalone-hooks';\n${transformed}\nexport const __standaloneValues={${namesOf(file).join(",")}${[...inline].map(([body,key])=>`,${key}:${body}`).join('')}};`, loader:"ts", resolveDir:dirname(args.path) };
      });
    } }] });
  const oracle = await import(`${pathToFileURL(oracleFile).href}?source=${digest([...sources.values()].join("\n"))}`);
  const owners = new Map();
  for (const name of sourceModules) for (const [key, value] of Object.entries(oracle.modules[name].__standaloneValues))
    if (isSchema(value) && !owners.has(value)) owners.set(value, { name, key });
  const extraHooks = new Map(sourceModules.map(name=>[name,[]]));
  for(const [schema,id] of oracle.hooks)if(!owners.has(schema)) {
    const source=hookSources.get(id);const extras=extraHooks.get(source.name);const key=`__hook${extras.length}`;
    owners.set(schema,{name:source.name,key});extras.push({key,schema});
  }
  const products = new Map(); let validatorCount=0;
  for (const name of sourceModules) {
    const file = asts.get(name), source=sources.get(name), values=oracle.modules[name].__standaloneValues;
    const imports = new Map(); const lines = []; const declarations=[]; const exportedSchemas=[];
    const ownKeys = new Map(Object.entries(values).filter(([,v])=>isSchema(v)).map(([k,v])=>[v,k]));
    function encode(schema, top) {
      return encodeSchema(schema, {
        reference(child) {
          if (child === top) return;
          if (ownKeys.has(child)) return sourceCode(ownKeys.get(child));
          const owner=owners.get(child);
          if (!owner || owner.name === name) return;
          const alias=`__ref${imports.size}`;
          const key=`${owner.name}/${owner.key}`;
          if(!imports.has(key))imports.set(key,{...owner,alias});
          return sourceCode(imports.get(key).alias);
        },
        hook(child) {
          const record=hookSources.get(oracle.hooks.get(child));
          if(!record)return;
          if (record.name !== name) throw new Error(`Cross-module private refinement requires a named validator: ${record.name} -> ${name}`);
          if(record.kind==='default')return {kind:'default',value:child._def.defaultValue()};
          if(record.kind==='lazy')return {kind:'jsonLazy'};
          if(record.kind==='custom')return {kind:'arrayBuffer',callback:sourceCode(record.callback),message:sourceCode(record.message)};
          let callback=record.callback;
          for(const [body,key]of inlines.get(name))callback=callback.replaceAll(body,key);
          return {kind:record.kind,callback:sourceCode(callback),message:record.message?sourceCode(record.message):undefined};
        },
        lazy(child) { return sourceCode(`()=>${literal(encode(child, null))}`); },
      });
    }
    for (const statement of file.statements) {
      if(ts.isImportDeclaration(statement)) {
        if(statement.importClause?.isTypeOnly||statement.moduleSpecifier.text==='./validation-runtime')continue;
        lines.push(statement.getText(file).replaceAll(/from "\.\/([^"\n]+)"/g,'from "./$1.mjs"')); continue;
      }
      if(ts.isVariableStatement(statement)) {
        for(const d of statement.declarationList.declarations) {
          const key=d.name.text, value=values[key];
          if(isSchema(value)) {
            // Same-module references to later declarations would change TDZ order.
            // A named alias is emitted as an alias, not a second parser instance.
            const owner=owners.get(value);
            const node=owner?.name===name&&owner.key!==key?sourceCode(owner.key):encode(value,value);
            lines.push(`export const ${key} = ${node?.sourceCode!==undefined?node.sourceCode:`/*#__PURE__*/ standalone(${literal(node)})`};`);
            validatorCount++;
            if(exported(statement)) { declarations.push(`export declare const ${key}: Compiled<typeof import("../${name}").${key}>;`);exportedSchemas.push(key); }
            else declarations.push(`export declare const ${key}: Parser<unknown>;`);
          } else {
            if(typeof value==='function'&&authoringCall.test(d.initializer.getText(file)))continue;
            const containsSchema = item=>isSchema(item)||(item&&typeof item==='object'&&Object.values(item).some(containsSchema));
            const encodeValue = item=>isSchema(item)?sourceCode(`standalone(${literal(encode(item,null))})`)
              :Array.isArray(item)?item.map(encodeValue):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).map(([k,v])=>[k,encodeValue(v)])):item;
            lines.push(`${exported(statement)?'export ':''}const ${key}=${containsSchema(value)?literal(encodeValue(value)):d.initializer.getText(file)};`);
            if(exported(statement))declarations.push(`export declare const ${key}: typeof import("../${name}").${key};`);
          }
        }
        continue;
      }
      if(ts.isFunctionDeclaration(statement)) {
        // Authoring factories have already been evaluated into closed programs.
        // No runtime schema builder is emitted or offered by the standalone API.
        if(authoringCall.test(statement.body.getText(file)))continue;
        lines.push(statement.getText(file)); continue;
      }
      if(ts.isExportDeclaration(statement)&&statement.moduleSpecifier) {
        const declaration=statement.getText(file).replace(/"\.\/([^"\n]+)"/,'"./$1.mjs"');
        lines.push(declaration);declarations.push(declaration);continue;
      }
      if(ts.isTypeAliasDeclaration(statement)||ts.isInterfaceDeclaration(statement)) {
        if(exported(statement)) {
          if(statement.typeParameters?.length)throw new Error(`Unsupported generic type facade: ${name}/${statement.name.text}`);
          declarations.push(`export type ${statement.name.text}=import("../${name}").${statement.name.text};`);
        }
        continue;
      }
      throw new Error(`Unsupported schema statement in ${name}: ${ts.SyntaxKind[statement.kind]}`);
    }
    for(const key of inlines.get(name).values())lines.push(`const ${key}=standalone(${literal(encode(values[key],values[key]))});`);
    for(const {key,schema}of extraHooks.get(name)) {
      lines.push(`export const ${key}=standalone(${literal(encode(schema,schema))});`);
      declarations.push(`export declare const ${key}: Parser<unknown>;`);
    }
    const prefix = `// Generated by packages/schema/scripts/generate-standalone.mjs. DO NOT EDIT.\n// Source SHA-256: ${digest(source)}; closed parse program v1.\n`;
    const addedImports=[...imports.values()].map(ref=>`import {${ref.key} as ${ref.alias}} from './${ref.name}.mjs';`).join('\n');
    let generated=transpile(`import {standalone} from './runtime.mjs';\n${addedImports}\n${lines.join('\n')}`).replaceAll('z.ZodIssueCode.custom','"custom"');
    const generatedAst=ts.createSourceFile(name,generated,ts.ScriptTarget.Latest,true);
    function checkNoBuilder(node) {
      if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='z')
        throw new Error(`Unsupported remaining schema builder in ${name}: ${node.getText(generatedAst)}`);
      ts.forEachChild(node,checkNoBuilder);
    }
    checkNoBuilder(generatedAst);
    // Retain PURE only on actual generated construction calls. These have no
    // observable effects until parse and can be omitted when a route is absent.
    generated=generated.replaceAll(/\bstandalone\(/g, '/*#__PURE__*/ standalone(');
    products.set(`${name}.mjs`,prefix+generated);
    products.set(`${name}.d.mts`,prefix+`import type { Compiled, Parser } from './runtime.mjs';\nexport type * from '../${name}';\n${declarations.join('\n')}\n`);
  }
  await mkdir(outputRoot,{recursive:true});
  const interned=internProgramFiles(products);
  for(const [file, input]of interned) {
    const bytes=file.endsWith('.mjs')?pureConstruction(input):input;
    const path=resolve(outputRoot,file);
    if(check) { if(await readFile(path,'utf8').catch(()=>null)!==bytes)throw new Error(`Stale generated standalone input: ${file}`); }
    else await writeFile(path,bytes);
  }
  return {modules:sourceModules.length,validators:validatorCount,files:interned.size,sourceSha256:digest([...sources.values()].join('\n'))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await generateStandalone({check:process.argv.includes('--check')})));
