import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
import { compareStyleWitnesses } from "./helpers/style-witnesses.mjs";
const require = createRequire(realpathSync(resolve("node_modules/vite/package.json")));
const postcss = require("postcss");
function sharedRules() {
  const primitives = new Map(), aliases = new Map();
  postcss.parse(readFileSync("src/app/primitives.css", "utf8")).walkRules(rule => {
    const declarations=rule.nodes.filter(n=>n.type==="decl").map(d=>[d.prop,d.value,!!d.important]);
    const match=rule.selector.match(/^\.ui:where\(\.(ui-[a-z0-9-]+)\)(.*)$/);
    if(match)primitives.set(match[1],{suffix:match[2].trim(),declarations});
    else for(const selector of rule.selectors)aliases.set(selector.trim(),[...(aliases.get(selector.trim())??[]),...declarations]);
  });
  return { primitives, aliases };
}
function readContract() {
  const contract=JSON.parse(readFileSync("test/fixtures/style-primitives.json","utf8"));
  // These modifiers deliberately keep their declarations after their base rules.
  // The cascade finder caught them; moving them to shared base primitives is unsafe.
  for(const name of ["intake-card-actions","shape-field-computed","shape-change-dot-now","timeslider-scrubbed"])delete contract.classes[name];
  return contract;
}

it.each(["source", "shell-first", "reverse-lazy"])("preserves the JSX cascade across %s stylesheet order and responsive/print contexts", order => {
  const contract=readContract();
  const files = order === "source" ? contract.files : [
    ...contract.files.filter(f=>f.path==="app/styles.css" || f.path==="share/ShareView.css"),
    ...(order === "reverse-lazy" ? [...contract.files].reverse() : contract.files)
      .filter(f=>f.path!=="app/styles.css" && f.path!=="share/ShareView.css"),
  ];
  const current=[];
  for(const file of ["app/primitives.css",...files.map(f=>f.path)])postcss.parse(readFileSync(`src/${file}`,"utf8")).walkRules(rule=>{
    const context=[];for(let p=rule.parent;p?.type==="atrule";p=p.parent)context.unshift([p.name,p.params]);
    current.push({selector:rule.selector,context,declarations:rule.nodes.filter(n=>n.type==="decl").map(d=>[d.prop,d.value,!!d.important])});
  });
  const result=compareStyleWitnesses(files.flatMap(f=>f.rules),current);
  expect(result.elements).toBeGreaterThan(1000);
  expect([...new Map(result.differences.map(d=>[JSON.stringify([d.classes,d.key,d.before,d.after]),d])).values()].slice(0,30)).toEqual([]);
},30000);

it("attaches the extracted primitives to every literal class carrier, including conditional templates", () => {
  const contract = readContract();
  const { primitives } = sharedRules();
  const missing = [];
  function directory(path) { for(const entry of readdirSync(path, { withFileTypes: true })) {
    const file = `${path}/${entry.name}`; if(entry.isDirectory()) { directory(file); continue; }
    if(!file.endsWith(".tsx"))continue;
    const source=ts.createSourceFile(file,readFileSync(file,"utf8"),99,true,ts.ScriptKind.TSX);
    function walk(n) {
      if(ts.isJsxAttribute(n) && /^(?:className|.*ClassName)$/.test(n.name.getText(source))) {
        function check(part) {
          if(ts.isStringLiteralLike(part)||ts.isTemplateLiteralToken(part)) {
            const tokens=part.text.split(/\s+/);
            for(const token of tokens)for(const primitive of contract.classes[token]??[])
              if(primitives.has(primitive) && !tokens.includes(primitive)) missing.push(`${file}: ${token} needs ${primitive}`);
          }
          ts.forEachChild(part,check);
        } if(n.initializer)check(n.initializer); return;
      }
      ts.forEachChild(n,walk);
    }walk(source);
  } } directory("src");
  expect(missing).toEqual([]);
});

it("keeps parameterized primitives at one-class specificity and native aliases at their exact original selectors", () => {
  const css = postcss.parse(readFileSync("src/app/primitives.css", "utf8"));
  expect(css.nodes.length).toBeGreaterThan(10);
  css.walkRules(rule => {
    if(rule.selector.startsWith(".ui:where("))expect(rule.selector).toMatch(/^\.ui:where\(\.ui-[a-z0-9-]+\)(?:[\s>:].*)?$/);
    else for(const selector of rule.selectors)expect(selector.trim()).toMatch(/^\.[\w-]+(?:[.\s>:[].*)?$/);
  });
  expect(css.nodes.some(rule=>rule.type==="rule" && / input$/.test(rule.selector))).toBe(true);
  expect(css.nodes.some(rule=>rule.type==="rule" && rule.nodes.some(d=>d.type==="decl" && d.prop==="border" && d.value==="var(--line-strong)"))).toBe(true);
});

it("preserves every factored declaration and every untouched theme/state/responsive/print rule", () => {
  const contract = readContract();
  const { primitives, aliases } = sharedRules();
  for(const [selector,declarations] of aliases) {
    const originals=contract.files.flatMap(f=>f.rules).filter(r=>r.context.length===0 && postcss.rule({selector:r.selector}).selectors.some(s=>s.trim()===selector));
    for(const declaration of declarations)expect(originals.some(r=>r.declarations.some(d=>JSON.stringify(d)===JSON.stringify(declaration)))).toBe(true);
  }
  for (const file of contract.files) {
    const current = postcss.parse(readFileSync(`src/${file.path}`, "utf8"));
    const actual = [];
    current.walkRules(rule => {
      const context = []; for (let p = rule.parent; p?.type === "atrule"; p = p.parent) context.unshift([p.name, p.params]);
      actual.push({ selector: rule.selector, context, declarations: rule.nodes.filter(n => n.type === "decl").map(d => [d.prop, d.value, !!d.important]) });
    });
    expect(actual.length).toBe(file.rules.length);
    for (let i = 0; i < actual.length; i++) {
      const original = file.rules[i]; const now = actual[i];
      expect([now.selector, now.context]).toEqual([original.selector, original.context]);
      for(const selector of postcss.rule({selector:now.selector}).selectors) {
        const part=selector.trim().match(/^\.([\w-]+)([\s>:].*)?$/);
        const shared=now.context.length===0 ? [...(aliases.get(selector.trim())??[]),...(part ? contract.classes[part[1]]??[] : []).flatMap(name=>{
          const primitive=primitives.get(name);return primitive?.suffix===(part[2]??"").trim().replace(/\s+/g," ") ? primitive.declarations : [];
        })]:[];
        expect([...now.declarations, ...shared.filter(d=>original.declarations.some(v=>JSON.stringify(v)===JSON.stringify(d)) && !now.declarations.some(v=>JSON.stringify(v)===JSON.stringify(d)))].sort()).toEqual([...original.declarations].sort());
      }
    }
  }
});
