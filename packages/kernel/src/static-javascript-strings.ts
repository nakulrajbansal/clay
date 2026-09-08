import * as acorn from "acorn";

type Node = acorn.Node & Record<string, unknown>;

const MAX_NODES = 100_000;
const MAX_STATIC_DEPTH = 64;
const MAX_VALUES = 8_192;
const MAX_TOTAL_CHARS = 16 * 1024 * 1024;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null
    && typeof (value as { type?: unknown }).type === "string";
}

function staticArray(node: Node, depth: number): readonly string[] | null {
  if (depth > MAX_STATIC_DEPTH || node.type !== "ArrayExpression") return null;
  const elements = (node as unknown as { elements: (Node | null)[] }).elements;
  if (elements.length > MAX_VALUES) return null;
  const values: string[] = [];
  for (const element of elements) {
    if (!element || element.type === "SpreadElement") return null;
    const value = staticString(element, depth + 1);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

function memberName(node: Node): string | null {
  if (node.type === "Identifier")
    return (node as unknown as { name: string }).name;
  if (node.type === "Literal") {
    const value = (node as unknown as { value: unknown }).value;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function staticString(node: Node, depth = 0): string | null {
  if (depth > MAX_STATIC_DEPTH) return null;
  if (node.type === "Literal") {
    const value = (node as unknown as { value: unknown }).value;
    return typeof value === "string" ? value : null;
  }
  if (node.type === "BinaryExpression") {
    const binary = node as unknown as { operator: string; left: Node; right: Node };
    if (binary.operator !== "+") return null;
    const left = staticString(binary.left, depth + 1);
    const right = staticString(binary.right, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (node.type === "TemplateLiteral") {
    const template = node as unknown as {
      expressions: Node[];
      quasis: { value: { cooked?: string | null } }[];
    };
    let value = template.quasis[0]?.value.cooked;
    if (typeof value !== "string") return null;
    for (let index = 0; index < template.expressions.length; index++) {
      const expression = staticString(template.expressions[index]!, depth + 1);
      const quasi = template.quasis[index + 1]?.value.cooked;
      if (expression === null || typeof quasi !== "string") return null;
      value += expression + quasi;
    }
    return value;
  }
  if (node.type === "CallExpression") {
    const call = node as unknown as { callee: Node; arguments: Node[]; optional?: boolean };
    if (call.optional || call.arguments.length > 1 || call.callee.type !== "MemberExpression")
      return null;
    const member = call.callee as unknown as {
      object: Node; property: Node; computed: boolean; optional?: boolean;
    };
    if (member.optional || memberName(member.property) !== "join") return null;
    const values = staticArray(member.object, depth + 1);
    if (values === null) return null;
    const separator = call.arguments.length === 0
      ? "," : staticString(call.arguments[0]!, depth + 1);
    return separator === null ? null : values.join(separator);
  }
  return null;
}

/**
 * Parse JavaScript with Acorn and return every statically recoverable string.
 * Acorn supplies cooked values for escapes/templates; BinaryExpression and
 * static template substitutions are folded without evaluating code.
 */
export function extractAcornStaticStrings(source: string): readonly string[] | null {
  if (source.length > 64 * 1024) return null;
  let root: Node;
  try {
    root = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    }) as unknown as Node;
  } catch {
    return Object.freeze([]);
  }
  const stack: Node[] = [root];
  const values = new Set<string>();
  let nodes = 0;
  let totalChars = 0;
  while (stack.length > 0) {
    if (++nodes > MAX_NODES || values.size > MAX_VALUES || totalChars > MAX_TOTAL_CHARS)
      return null;
    const node = stack.pop()!;
    const value = staticString(node);
    if (value !== null && !values.has(value)) {
      values.add(value);
      totalChars += value.length;
    }
    for (const child of Object.values(node)) {
      if (isNode(child)) stack.push(child);
      else if (Array.isArray(child)) {
        for (let index = child.length - 1; index >= 0; index--)
          if (isNode(child[index])) stack.push(child[index]);
      }
    }
  }
  return Object.freeze([...values]);
}
