import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { minify as structurallyMinify } from "csso";
import {
  browserslistToTargets,
  transform as lightningTransform,
} from "lightningcss";
import ts from "typescript";

export const CSS_BROWSER_TARGETS = Object.freeze({
  browserslist: ["chrome 111", "firefox 113", "safari 16.2"],
  vite: ["chrome111", "firefox113", "safari16.2"],
});
const LIGHTNING_CSS_TARGETS = browserslistToTargets(CSS_BROWSER_TARGETS.browserslist);

const SOURCE_EXTENSIONS = new Set([".css", ".js", ".jsx", ".ts", ".tsx"]);
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CLASS_TOKEN = /[_A-Za-z][_A-Za-z0-9-]*/g;
const KEYFRAME_DECLARATION = /@(?:-webkit-)?keyframes\s+([_A-Za-z][_A-Za-z0-9-]*)/g;

// These names cross the shell/sandbox boundary through panelThemeCss. Keep the
// public contract stable; shell-only aliases may still be compacted.
const PUBLIC_THEME_PROPERTIES = new Set([
  "--font", "--font-display", "--bg", "--panel", "--border", "--border-strong",
  "--border-2", "--bg-soft", "--text", "--text-2", "--text-3", "--accent",
  "--accent-hover", "--accent-soft", "--accent-text", "--accent-on", "--chart-area",
]);

function sourceFilesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesBelow(path));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files.sort();
}

function compactName(index) {
  const base = NAME_ALPHABET.length;
  return (index >= base ? compactName(Math.floor(index / base) - 1) : "")
    + NAME_ALPHABET[index % base];
}

function assignCompactNames(counts, eligible, reserved, prefix = "") {
  const ordered = [...eligible].sort((left, right) =>
    (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || left.localeCompare(right));
  const assigned = new Map();
  const used = new Set();
  let index = 0;
  for (const original of ordered) {
    let compact;
    do compact = `${prefix}${compactName(index++)}`;
    while (reserved.has(compact) || used.has(compact));
    assigned.set(original, compact);
    used.add(compact);
  }
  return assigned;
}

function assignClassNames(counts, eligible, reserved) {
  const ranked = [...assignCompactNames(counts, eligible, reserved).keys()];
  const assigned = assignCompactNames(counts, new Set(ranked.slice(0, NAME_ALPHABET.length)), reserved);
  const used = new Set(assigned.values()), families = new Map();
  for (const original of ranked.slice(NAME_ALPHABET.length)) {
    const family = original.includes("-") ? original.split("-")[0] : "other";
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(original);
  }
  // Names in the same component tend to occur together in both selectors and
  // JSX. Preserve that locality after shortening, rather than scattering the
  // family over an unrelated frequency-ranked alphabet. No selector is removed.
  let group = 0;
  for (const [, originals] of [...families].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const prefix = compactName(group++); let index = 0;
    for (const original of originals) {
      let compact;
      do compact = prefix + compactName(index++);
      while (reserved.has(compact) || used.has(compact));
      assigned.set(original, compact); used.add(compact);
    }
  }
  return assigned;
}

function visitSelectorComponents(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) visitSelectorComponents(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "class" && typeof value.name === "string") visitor(value);
  for (const child of Object.values(value)) visitSelectorComponents(child, visitor);
}

function collectCssSymbols(cssSources) {
  const classes = new Map();
  const customProperties = new Map();
  const keyframes = new Map();
  for (const { id, code } of [...cssSources].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const match of code.matchAll(KEYFRAME_DECLARATION))
      keyframes.set(match[1], (keyframes.get(match[1]) ?? 0) + 1);
    lightningTransform({
      filename: id,
      code: Buffer.from(code),
      minify: false,
      visitor: {
        Selector(selector) {
          visitSelectorComponents(selector, component => {
            classes.set(component.name, (classes.get(component.name) ?? 0) + 1);
          });
        },
        DashedIdent(name) {
          customProperties.set(name, (customProperties.get(name) ?? 0) + 1);
        },
        CustomIdent(name) {
          if (keyframes.has(name)) keyframes.set(name, (keyframes.get(name) ?? 0) + 1);
        },
      },
    });
  }
  return { classes, customProperties, keyframes };
}

function scriptKind(id) {
  if (id.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (id.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (id.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isLiteralToken(node) {
  return ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node);
}

function propertyNameText(node, sourceFile) {
  return node.getText(sourceFile).replace(/^["']|["']$/g, "");
}

function isClassBearingLiteral(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current))
      return /^(?:className|.*ClassName)$/.test(current.name.getText(sourceFile));
    if (ts.isPropertyAssignment(current)
        && /^(?:className|.*ClassName)$/.test(propertyNameText(current.name, sourceFile)))
      return true;
    if (ts.isBinaryExpression(current)
        && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && /\.className$/.test(current.left.getText(sourceFile)))
      return true;
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText(sourceFile);
      if (/(?:querySelector(?:All)?|closest|matches|getElementsByClassName)$/.test(callee)
          || /\.classList\.(?:add|remove|toggle|contains|replace)$/.test(callee)) return true;
      if (/\.setAttribute$/.test(callee)
          && ts.isStringLiteralLike(current.arguments[0])
          && current.arguments[0].text === "class") return true;
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function analyzeCodeSource(code, id) {
  const sourceFile = ts.createSourceFile(
    id, code, ts.ScriptTarget.Latest, true, scriptKind(id),
  );
  const literals = [];
  const styleTokens = new Set();
  const styleTokenCounts = new Map();
  function visit(node) {
    if (isLiteralToken(node) && typeof node.text === "string") {
      const style = isClassBearingLiteral(node, sourceFile);
      if (style) {
        for (const token of node.text.match(CLASS_TOKEN) ?? []) {
          styleTokens.add(token);
          styleTokenCounts.set(token, (styleTokenCounts.get(token) ?? 0) + 1);
        }
      }
      literals.push({ start: node.getStart(sourceFile), end: node.end, style });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { literals, styleTokens, styleTokenCounts };
}

export function buildCssSymbolPlan({ cssSources, codeSources }) {
  const css = collectCssSymbols(cssSources);
  const styleTokens = new Set();
  const usage = new Map(css.classes);
  for (const source of [...codeSources].sort((a, b) => a.id.localeCompare(b.id))) {
    const analysis = analyzeCodeSource(source.code, source.id);
    for (const token of analysis.styleTokens) styleTokens.add(token);
    for (const [token, count] of analysis.styleTokenCounts)
      usage.set(token, (usage.get(token) ?? 0) + count);
  }

  // Only identifiers found inside class-bearing syntax are eligible. Ordinary
  // text/protocol strings remain untouched, and runtime-only variant names stay
  // semantic because they have no static class token to synchronize with CSS.
  const eligibleClasses = new Set([...css.classes.keys()].filter(name =>
    styleTokens.has(name)));
  const classes = assignClassNames(
    usage, eligibleClasses, new Set([...css.classes.keys(), ...styleTokens]),
  );
  const customProperties = assignCompactNames(
    css.customProperties,
    new Set(css.customProperties.keys()),
    new Set(css.customProperties.keys()),
    "--",
  );
  const codeCustomProperties = new Map([...customProperties]
    .filter(([name]) => !PUBLIC_THEME_PROPERTIES.has(name)));
  for (const publicName of PUBLIC_THEME_PROPERTIES) {
    const compact = customProperties.get(publicName);
    if (compact) codeCustomProperties.set(`--shell-${publicName.slice(2)}`, compact);
  }
  const keyframes = assignCompactNames(
    css.keyframes, new Set(css.keyframes.keys()), new Set(css.keyframes.keys()),
  );
  return { classes, codeCustomProperties, customProperties, keyframes };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceMappedIdentifiers(source, mapping) {
  if (mapping.size === 0) return source;
  const alternatives = [...mapping.keys()]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(`(?<![_A-Za-z0-9-])(?:${alternatives})(?![_A-Za-z0-9-])`, "g");
  return source.replace(pattern, original => mapping.get(original) ?? original);
}

export function transformStyleSource(code, id, plan) {
  const { literals } = analyzeCodeSource(code, id);
  const edits = [];
  for (const literal of literals) {
    const original = code.slice(literal.start, literal.end);
    let replacement = original;
    if (literal.style) replacement = replaceMappedIdentifiers(replacement, plan.classes);
    replacement = replaceMappedIdentifiers(replacement, plan.codeCustomProperties);
    if (replacement !== original) edits.push({ ...literal, replacement });
  }
  let transformed = code;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    transformed = transformed.slice(0, edit.start) + edit.replacement + transformed.slice(edit.end);
  return transformed;
}

export function transformCss(code, id, plan) {
  const transformed = lightningTransform({
    filename: id,
    code: Buffer.from(code),
    minify: true,
    targets: LIGHTNING_CSS_TARGETS,
    visitor: {
      Selector(selector) {
        visitSelectorComponents(selector, component => {
          component.name = plan.classes.get(component.name) ?? component.name;
        });
        return selector;
      },
      DashedIdent(name) {
        return plan.customProperties.get(name) ?? name;
      },
      CustomIdent(name) {
        return plan.keyframes.get(name) ?? name;
      },
    },
  });
  return structurallyMinify(Buffer.from(transformed.code).toString("utf8"), {
    restructure: true,
  }).css;
}

export function createProductionCssOptimizer({ sourceRoot }) {
  const root = resolve(sourceRoot);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const files = sourceFilesBelow(root);
  const cssSources = files.filter(file => extname(file) === ".css")
    .map(id => ({ id, code: readFileSync(id, "utf8") }));
  const codeSources = files.filter(file => CODE_EXTENSIONS.has(extname(file)))
    .map(id => ({ id, code: readFileSync(id, "utf8") }));
  const plan = buildCssSymbolPlan({ cssSources, codeSources });
  return {
    name: "clay-production-css-optimizer",
    apply: "build",
    enforce: "pre",
    transform(code, rawId) {
      const id = rawId.replace(/[?#].*$/, "");
      const resolvedId = resolve(id);
      if (resolvedId !== root && !resolvedId.startsWith(rootPrefix)) return null;
      const extension = extname(id);
      if (extension === ".css") return { code: transformCss(code, id, plan), map: null };
      if (CODE_EXTENSIONS.has(extension))
        return { code: transformStyleSource(code, id, plan), map: null };
      return null;
    },
  };
}
