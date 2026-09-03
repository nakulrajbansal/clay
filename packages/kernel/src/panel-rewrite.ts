import * as acorn from "acorn";

type Node = acorn.Node & Record<string, unknown>;
type Edit = { start: number; end: number; replacement: string };

const isNode = (value: unknown): value is Node =>
  !!value && typeof value === "object" && typeof (value as Node).type === "string";

function propertyName(node: Node): string | null {
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

const DIRECT_FIELD_KEYS = new Set(["field", "name", "column"]);
const FIELD_ARRAY_KEYS = new Set(["select", "groupBy", "fields", "columns"]);
const ROW_ROOTS = new Set(["r", "row", "rows", "record", "records", "item", "items"]);

function rootName(node: Node): string | null {
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "MemberExpression" && isNode(node.object)) return rootName(node.object);
  if (node.type === "ChainExpression" && isNode(node.expression)) return rootName(node.expression);
  return null;
}

const isRowAccess = (member: Node): boolean =>
  member.type === "MemberExpression" && isNode(member.object)
    && ROW_ROOTS.has(rootName(member.object) ?? "");

function isWritePayloadKey(node: Node, parent: Node | undefined,
  object: Node | undefined, call: Node | undefined): boolean {
  if (!parent || !object || !call || parent.type !== "Property" || parent.key !== node
      || object.type !== "ObjectExpression" || call.type !== "CallExpression") return false;
  const invocation = call as unknown as { callee: Node; arguments: Node[] };
  if (!isNode(invocation.callee) || invocation.callee.type !== "MemberExpression") return false;
  const method = isNode(invocation.callee.property) ? propertyName(invocation.callee.property) : null;
  const payloadIndex = method === "insert" ? 1 : method === "update" ? 2 : -1;
  return payloadIndex >= 0 && invocation.arguments[payloadIndex] === object;
}

/** Rewrite only syntactic field references, never comments or unrelated prose. */
export function renamePanelFieldReferences(code: string, from: string, to: string): string {
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Node;
  const edits: Edit[] = [];

  const visit = (node: Node, ancestors: Node[]): void => {
    const parent = ancestors.at(-1);
    const grandparent = ancestors.at(-2);
    const greatgrandparent = ancestors.at(-3);
    if (node.type === "Identifier" && node.name === from
        && ((parent?.type === "MemberExpression" && isRowAccess(parent)
            && parent.property === node && parent.computed !== true)
          || isWritePayloadKey(node, parent, grandparent, greatgrandparent))) {
      edits.push({ start: node.start, end: node.end, replacement: to });
    }
    if (node.type === "Literal" && node.value === from && parent) {
      let fieldReference = isRowAccess(parent)
        && parent.property === node && parent.computed === true;
      if (parent.type === "Property" && parent.value === node) {
        const key = isNode(parent.key) ? propertyName(parent.key) : null;
        fieldReference ||= key !== null && DIRECT_FIELD_KEYS.has(key);
      }
      if (parent.type === "ArrayExpression" && grandparent?.type === "Property"
          && grandparent.value === parent) {
        const key = isNode(grandparent.key) ? propertyName(grandparent.key) : null;
        fieldReference ||= key !== null && FIELD_ARRAY_KEYS.has(key);
      }
      fieldReference ||= isWritePayloadKey(node, parent, grandparent, greatgrandparent);
      if (fieldReference)
        edits.push({ start: node.start, end: node.end, replacement: JSON.stringify(to) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (isNode(value)) visit(value, [...ancestors, node]);
      else if (Array.isArray(value))
        for (const child of value) if (isNode(child)) visit(child, [...ancestors, node]);
    }
  };
  visit(ast, []);
  let out = code;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return out;
}
