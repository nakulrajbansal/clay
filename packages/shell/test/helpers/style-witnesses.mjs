// A conservative JSX/CSS cascade finder, not layout or browser certification.
// Branches are combined so a composed state cannot lose a declaration silently.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { JSDOM } from "jsdom";
const require = createRequire(realpathSync(resolve("../../node_modules/csso/package.json")));
const tree = require("css-tree");

function specificity(selector) {
  const ast=tree.parse(selector,{context:"selectorList"});
  function score(node) {
    if(node.type==="ClassSelector"||node.type==="AttributeSelector")return 1000;
    if(node.type==="IdSelector")return 1000000;
    if(node.type==="TypeSelector")return node.name==="*"?0:1;
    if(node.type==="PseudoElementSelector")return 1;
    if(node.type==="PseudoClassSelector") {
      if(node.name==="where")return 0;
      if(["is","not","has"].includes(node.name))return Math.max(0,...node.children.toArray().map(score));
      return 1000;
    }
    if(node.type==="SelectorList")return Math.max(0,...node.children.toArray().map(score));
    return node.children ? node.children.toArray().reduce((n,child)=>n+score(child),0):0;
  } return score(ast);
}
function slots(prop) {
  if(prop==="font")return ["font-size","font-family","font-weight","font-style","font-variant","font-stretch","line-height"];
  if(prop==="background")return ["background-color","background-image","background-size","background-position","background-repeat","background-attachment","background-origin","background-clip"];
  if(prop==="flex")return ["flex-grow","flex-shrink","flex-basis"];
  if(prop==="gap")return ["row-gap","column-gap"];
  if(prop==="place-items")return ["align-items","justify-items"];
  if(prop==="place-content")return ["align-content","justify-content"];
  if(prop==="overflow")return ["overflow-x","overflow-y"];
  if(prop==="border"||/^border-(top|right|bottom|left)$/.test(prop))return (prop==="border"?["top","right","bottom","left"]:[prop.slice(7)]).flatMap(side=>["width","style","color"].map(part=>`border-${side}-${part}`));
  if(prop==="margin"||prop==="padding"||prop==="inset")return ["top","right","bottom","left"].map(side=>prop==="inset"?side:`${prop}-${side}`);
  return [prop];
}

export function compareStyleWitnesses(before,after, { states = ["rest", "engaged", "disabled"] } = {}) {
  const dom=new JSDOM("<!doctype html><html><body></body></html>");const doc=dom.window.document;
  const elements=[];
  function directory(path) {for(const entry of readdirSync(path,{withFileTypes:true})) {
    const file=`${path}/${entry.name}`;if(entry.isDirectory()){directory(file);continue;}if(!file.endsWith(".tsx"))continue;
    const source=ts.createSourceFile(file,readFileSync(file,"utf8"),99,true,ts.ScriptKind.TSX);
    function textValues(node) {const out=[];function visit(n){if(ts.isStringLiteralLike(n)||ts.isTemplateLiteralToken(n))out.push(n.text);ts.forEachChild(n,visit);}if(node)visit(node);return out;}
    function visit(n,parent) {
      if(ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n)) {
        const opening=ts.isJsxElement(n)?n.openingElement:n; const name=opening.tagName.getText(source);
        const tag=({FocusInput:"input",FocusSelect:"select",FocusButton:"button",ModalDialog:"section"})[name]??(/^[a-z]/.test(name)?name:"div");
        const element=doc.createElement(tag);
        for(const attr of opening.attributes.properties)if(ts.isJsxAttribute(attr)) {
          const key=attr.name.getText(source),values=textValues(attr.initializer);
          if(key==="className")element.className=values.join(" ");
          else if(key==="id"||key==="type"||key.startsWith("aria-")||key.startsWith("data-"))element.setAttribute(key,values[0]??"");
        }
        parent.append(element);elements.push({element,file});
        if(ts.isJsxElement(n))for(const child of n.children)visit(child,element);return;
      }
      ts.forEachChild(n,child=>visit(child,parent));
    }visit(source,doc.body);
  }} directory("src");
  const media=[...new Set(before.flatMap(rule=>rule.context.filter(x=>x[0]==="media").map(x=>JSON.stringify(x))))];
  const contexts=[{id:"",active:new Set()},...media.map(key=>({id:key,active:new Set([key])}))];
  for(const width of [1280,320,160])for(const dark of [false,true])for(const reduced of [false,true]) {
    const active=new Set(media.filter(key=>{
      const [,query]=JSON.parse(key),maximum=query.match(/^\(max-width:\s*(\d+)px\)$/);
      if(maximum)return width<=Number(maximum[1]);
      if(query==="(prefers-color-scheme: dark)")return dark;
      if(query==="(prefers-reduced-motion: reduce)")return reduced;
      if(query==="print")return false;
      throw new Error(`Unsupported style witness media: ${query}`);
    }));
    contexts.push({id:`screen:${width}:dark=${dark}:reduced=${reduced}`,active});
  }
  // Match each selector once, then replay declaration precedence per media context.
  const memo=new Map();
  function prepared(rules,state){return rules.map(rule=>{
    if(rule.context.some(([name])=>name.endsWith("keyframes")))return {...rule,matches:new Map()};
    const matches=new Map(); const ast=tree.parse(rule.selector,{context:"selectorList"});
    for(const part of ast.children){const selector=tree.generate(part),key=state+":"+selector;let result=memo.get(key);
      if(!result){
        // Pseudo-elements keep their exact declaration contract, but do not
        // correspond to DOM nodes. Interactive pseudo-classes are explicit
        // witness states; jsdom's lack of hover must not hide a cascade change.
        const query=selector.replace(/:(hover|active|focus-visible|focus-within|focus|disabled|checked)(?![\w-])/g, '[data-style-$1]');
        try { result=selector.includes("::")?new Set():new Set(doc.querySelectorAll(query)); }
        catch { throw new Error(`Unsupported style witness selector: ${query}`); }
        memo.set(key,result);
      }
      const weight=specificity(selector);for(const element of result)matches.set(element,Math.max(matches.get(element)??0,weight));
    }
    return {...rule,matches};
  });}
  const differences=[];
  function cascade(rules,context){const map=new Map();for(const rule of rules){
    if(rule.context.length&& !rule.context.every(x=>context.active.has(JSON.stringify(x))))continue;
    for(const[element,spec]of rule.matches){let declarations=map.get(element);if(!declarations){declarations=new Map();map.set(element,declarations);}
      for(const[prop,value,important]of rule.declarations){const weight=spec+(important?1000000000:0);for(const slot of slots(prop)){
        const previous=declarations.get(slot);if(!previous||weight>=previous.weight)declarations.set(slot,{weight,value:prop+":"+value,selector:rule.selector});
      }}
    }
  }return map;}
  for(const state of states){
    for(const {element} of elements)for(const name of ["hover","active","focus-visible","focus-within","focus","disabled","checked"]){
      const on=state==="engaged"?name!=="disabled":state==="disabled"?name==="disabled":false;
      if(on)element.setAttribute(`data-style-${name}`,"");else element.removeAttribute(`data-style-${name}`);
    }
    const left=prepared(before,state),right=prepared(after,state);
    for(const context of contexts){const a=cascade(left,context),b=cascade(right,context);
    for(const{element,file}of elements){const old=a.get(element)??new Map(),next=b.get(element)??new Map();for(const key of new Set([...old.keys(),...next.keys()])){
      if(old.get(key)?.value!==next.get(key)?.value)differences.push({file,tag:element.tagName,classes:element.className,key,context:context.id,state,before:old.get(key)?.value,after:next.get(key)?.value,beforeSelector:old.get(key)?.selector,afterSelector:next.get(key)?.selector});
    }}
  }
  }
  dom.window.close();return {elements:elements.length,differences};
}
