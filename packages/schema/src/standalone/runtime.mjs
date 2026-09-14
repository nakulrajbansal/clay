// Closed, synchronous version-1 parse-program interpreter. Programs are generated
// from reviewed source, never accepted from a panel, provider, archive or user.
// Compatibility follows the pinned Zod 3.25.76 oracle; no runtime code generation.
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
const values = (items, separator = " | ") => items.map(x => typeof x === "string" ? `'${x}'` : x).join(separator);
function parsedType(value) {
  const type = typeof value;
  if (type === "number") return Number.isNaN(value) ? "nan" : type;
  if (type !== "object") return type;
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (value.then && typeof value.then === "function" && value.catch && typeof value.catch === "function") return "promise";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (value instanceof Date) return "date";
  return "object";
}
function message(i) {
  switch (i.code) {
    case "invalid_type": return i.received === "undefined" ? "Required" : `Expected ${i.expected}, received ${i.received}`;
    case "invalid_literal": return `Invalid literal value, expected ${stringify(i.expected)}`;
    case "unrecognized_keys": return `Unrecognized key(s) in object: ${values(i.keys, ", ")}`;
    case "invalid_union_discriminator": return `Invalid discriminator value. Expected ${values(i.options)}`;
    case "invalid_enum_value": return `Invalid enum value. Expected ${values(i.options)}, received '${i.received}'`;
    case "invalid_string": return i.validation === "regex" ? "Invalid" : `Invalid ${i.validation}`;
    case "too_small":
      if (i.type === "array" || i.type === "string") return `${i.type === "array" ? "Array" : "String"} must contain ${i.exact ? "exactly" : i.inclusive ? "at least" : i.type === "array" ? "more than" : "over"} ${i.minimum} ${i.type === "array" ? "element(s)" : "character(s)"}`;
      return `Number must be ${i.exact ? "exactly equal to " : i.inclusive ? "greater than or equal to " : "greater than "}${i.minimum}`;
    case "too_big":
      if (i.type === "array" || i.type === "string") return `${i.type === "array" ? "Array" : "String"} must contain ${i.exact ? "exactly" : i.inclusive ? "at most" : i.type === "array" ? "less than" : "under"} ${i.maximum} ${i.type === "array" ? "element(s)" : "character(s)"}`;
      return `Number must be ${i.exact ? "exactly" : i.inclusive ? "less than or equal to" : "less than"} ${i.maximum}`;
    case "not_finite": return "Number must be finite";
    case "custom": case "invalid_union": return "Invalid input";
    default: throw new Error("Unsupported standalone issue");
  }
}
export class StandaloneError extends Error {
  constructor(issues) { super(); this.issues = issues; this.name = "ZodError"; }
  get message() { return stringify(this.issues); }
  get errors() { return this.issues; }
  toString() { return this.message; }
}
const invalid = { status: 2 };
function run(program, value, path, issues) {
  const n = program.node ?? program;
  let status = 0;
  const add = issue => {
    issues.push({ ...issue, path: [...path, ...(issue.path || [])], message: issue.message ?? message(issue) });
    status = issue.fatal ? 2 : Math.max(status, 1);
  };
  const wrong = (expected, received = parsedType(value)) => { add({ code: "invalid_type", expected, received }); return invalid; };
  const parse = (node, input, key) => run(node, input, key === undefined ? path : [...path, key], issues);
  const merge = result => { status = Math.max(status, result.status); return result.value; };
  const bound = (small, limit, type, exact = false, inclusive = true, customMessage) => add({ code: small ? "too_small" : "too_big",
    [small ? "minimum" : "maximum"]: limit, type, inclusive, exact, message: customMessage });
  switch (n[0]) {
    case 0: case 1: {
      const type = n[0] === 0 ? "string" : "number";
      if (parsedType(value) !== type) return wrong(type);
      for (const c of n[1]) {
        const count = type === "string" ? value.length : value;
        switch (c[0]) {
          case 0: if (c[2] ? count < c[1] : count <= c[1]) bound(true, c[1], type, false, c[2], c[3]); break;
          case 1: if (c[2] ? count > c[1] : count >= c[1]) bound(false, c[1], type, false, c[2], c[3]); break;
          case 2: if (count !== c[1]) bound(count < c[1], c[1], type, true, true, c[2]); break;
          case 3: c[1].lastIndex = 0; if (!c[1].test(value)) add(c[2] === "datetime"
            ? { code: "invalid_string", validation: c[2], message: c[3] }
            : { validation: c[2], code: "invalid_string", message: c[3] }); break;
          case 4: try { new URL(value); } catch { add({ validation: "url", code: "invalid_string", message: c[1] }); } break;
          case 5: if (!Number.isInteger(value)) add({ code: "invalid_type", expected: "integer", received: "float", message: c[1] }); break;
          case 6: if (!Number.isFinite(value)) add({ code: "not_finite", message: c[1] }); break;
          case 7: value = value.trim(); break;
          default: throw new Error("Unsupported standalone check");
        }
      }
      break;
    }
    case 2: if (parsedType(value) !== "boolean") return wrong("boolean"); break;
    case 3: if (parsedType(value) !== "null") return wrong("null"); break;
    case 4: if (value !== n[1]) { parsedType(value); add({ received: value, code: "invalid_literal", expected: n[1] }); return invalid; } break;
    case 5:
      if (typeof value !== "string") { add({ expected: values(n[1]), received: parsedType(value), code: "invalid_type" }); return invalid; }
      if (!n[1].includes(value)) { add({ received: value, code: "invalid_enum_value", options: n[1] }); return invalid; }
      break;
    case 6: {
      if (parsedType(value) !== "object") return wrong("object");
      parsedType(value);
      const extra = []; const fields = Object.entries(n[1]), keys = fields.map(p => p[0]);
      if (n[2] !== 0) for (const key in value) if (!keys.includes(key)) extra.push(key);
      const pairs = fields.map(([key, node]) => [key, parse(node, value[key], key), key in value]);
      if (n[2] === 1 && extra.length) add({ code: "unrecognized_keys", keys: extra });
      if (n[2] === 2) for (const key of extra) pairs.push([key, {status: 0, value: value[key]}, false]);
      const output = {};
      for (const [key, result, present] of pairs) {
        const item = merge(result);
        if (key !== "__proto__" && (item !== undefined || present)) output[key] = item;
      }
      value = output; break;
    }
    case 7: case 9: {
      const type=parsedType(value); if (type !== "array") return wrong("array",type);
      if (n[0] === 9) {
        if (value.length < n[1].length) { add({ code: "too_small", minimum: n[1].length, inclusive: true, exact: false, type: "array" }); return invalid; }
        if (value.length > n[1].length) add({ code: "too_big", maximum: n[1].length, inclusive: true, exact: false, type: "array" });
        value = [...value].slice(0, n[1].length).map((item, index) => merge(parse(n[1][index], item, index)));
      } else {
        if (n[4]) {
          const big = value.length > n[4][0], small = value.length < n[4][0];
          if (big || small) add({ code: big ? "too_big" : "too_small", minimum: small ? n[4][0] : undefined,
            maximum: big ? n[4][0] : undefined, type: "array", inclusive: true, exact: true, message: n[4][1] });
        }
        if (n[2] && value.length < n[2][0]) bound(true, n[2][0], "array", false, true, n[2][1]);
        if (n[3] && value.length > n[3][0]) bound(false, n[3][0], "array", false, true, n[3][1]);
        value = [...value].map((item, index) => merge(parse(n[1], item, index)));
      }
      break;
    }
    case 8: {
      const type=parsedType(value); if (type !== "object") return wrong("object",type);
      const output = {}; const pairs = [];
      for (const key in value) pairs.push([parse(n[1], key, key), parse(n[2], value[key], key), key in value]);
      for (const [keyResult, result, present] of pairs) {
        const key = merge(keyResult), item = merge(result);
        if (key !== "__proto__" && (item !== undefined || present)) output[key] = item;
      }
      value = output; break;
    }
    case 10: {
      parsedType(value);
      const errors = []; let dirty;
      for (const option of n[1]) {
        const own = []; const result = run(option, value, path, own);
        if (result.status === 0) return result;
        if (result.status === 1 && !dirty) dirty = { result, own };
        if (own.length) errors.push(own);
      }
      if (dirty) { issues.push(...dirty.own); return dirty.result; }
      add({ code: "invalid_union", unionErrors: errors.map(error => new StandaloneError(error)) }); return invalid;
    }
    case 11: {
      const type=parsedType(value); if (type !== "object") return wrong("object",type);
      const discriminator = value[n[1]];
      const option = n[2].find(pair => pair[0] === discriminator);
      if (!option) { add({ code: "invalid_union_discriminator", options: n[2].map(pair => pair[0]), path: [n[1]] }); return invalid; }
      return parse(option[1], value);
    }
    case 12: if (parsedType(value) === "undefined") break; return parse(n[1], value);
    case 13: if (parsedType(value) === "null") break; return parse(n[1], value);
    case 14: case 15: {
      parsedType(value);
      const inner = parse(n[1], value);
      if (inner.status === 2) return invalid;
      value = merge(inner);
      if (n[0] === 14) {
        const result = n[2](value);
        if (result instanceof Promise) throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        if (!result) add({ code: "custom", ...(typeof n[3] === "string" || n[3] === undefined ? { message: n[3] } : n[3]) });
      } else {
        const result = n[2](value, { addIssue: add, get path() { return path; } });
        if (result instanceof Promise) throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
      }
      break;
    }
    case 16: parsedType(value); return parse(n[1], value === undefined ? n[2] : value);
    case 17: parsedType(value); return parse(n[1](), value);
    case 18: break;
    case 19: parsedType(value); if(!n[1](value))add({code:'custom',message:n[2],fatal:true});break;
    default: throw new Error("Unsupported standalone program");
  }
  return { status, value };
}
export function standalone(node) {
  const result = {
    node,
    safeParse(value) {
      parsedType(value);
      const issues = []; const parsed = run(node, value, [], issues);
      if (parsed.status === 0) return { success: true, data: parsed.value };
      return { success: false, error: new StandaloneError(issues) };
    },
    parse(value) { const parsed = result.safeParse(value); if (!parsed.success) throw parsed.error; return parsed.data; },
  };
  if (node[0] === 5) result.options = node[1];
  return result;
}
