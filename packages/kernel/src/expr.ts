// ExpressionEngine — the safe expression language (doc 04 §6).
// Shared by computed columns, backfill exprs, and clay.compute.eval (G20).
// Pratt parser; static type check against a field scope; total evaluator
// (well-typed expressions never throw — PB4): nulls propagate, division by
// zero and non-finite results become null.
import { ClayError } from "./errors";

export type ExprType = "number" | "text" | "bool" | "date";
export type ExprValue = number | string | boolean | null;
export type ExprScope = Record<string, ExprType>;

export type BinOp =
  | "+" | "-" | "*" | "/" | "%"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "and" | "or";

export type ExprAst =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "field"; name: string }
  | { k: "un"; op: "neg" | "not"; e: ExprAst }
  | { k: "bin"; op: BinOp; l: ExprAst; r: ExprAst }
  | { k: "call"; fn: string; args: ExprAst[] };

const MAX_DEPTH = 32;
const DEFAULT_BUDGET = 10_000;

// ---------- tokenizer ----------
type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "ident"; v: string }
  | { k: "op"; v: string }
  | { k: "end" };

function err(msg: string): never {
  throw new ClayError("E_EXPR", msg);
}

function tokenize(src: string): Tok[] {
  if (src.length > 500) err("expression longer than 500 chars");
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && src[j]! >= "0" && src[j]! <= "9") j++;
      if (src[j] === ".") {
        j++;
        if (!(src[j]! >= "0" && src[j]! <= "9")) err(`bad number at ${i}`);
        while (j < src.length && src[j]! >= "0" && src[j]! <= "9") j++;
      }
      toks.push({ k: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, i + 1);
      if (close < 0) err("unterminated string");
      toks.push({ k: "str", v: src.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if ((c >= "a" && c <= "z") || c === "_") {
      let j = i;
      while (j < src.length && /[a-z0-9_]/.test(src[j]!)) j++;
      toks.push({ k: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
      toks.push({ k: "op", v: two }); i += 2; continue;
    }
    if ("+-*/%<>(),".includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    err(`unexpected character '${c}' at ${i}`);
  }
  toks.push({ k: "end" });
  return toks;
}

// ---------- parser (Pratt) ----------
const FN_ARITY: Record<string, { min: number; max: number }> = {
  min: { min: 2, max: 8 }, max: { min: 2, max: 8 },
  abs: { min: 1, max: 1 }, round: { min: 1, max: 1 },
  floor: { min: 1, max: 1 }, ceil: { min: 1, max: 1 },
  len: { min: 1, max: 1 }, coalesce: { min: 2, max: 8 },
  days_between: { min: 2, max: 2 }, if: { min: 3, max: 3 },
  contains: { min: 2, max: 2 }, lower: { min: 1, max: 1 },
  concat: { min: 1, max: 8 },
};

function bindingPower(t: Tok): { op: BinOp; lbp: number } | null {
  if (t.k === "ident" && (t.v === "and" || t.v === "or"))
    return { op: t.v, lbp: t.v === "or" ? 1 : 2 };
  if (t.k !== "op") return null;
  switch (t.v) {
    case "==": case "!=": case "<": case "<=": case ">": case ">=":
      return { op: t.v, lbp: 3 };
    case "+": case "-": return { op: t.v, lbp: 4 };
    case "*": case "/": case "%": return { op: t.v, lbp: 5 };
    default: return null;
  }
}

export function parseExpr(src: string): ExprAst {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok => toks[pos]!;
  const next = (): Tok => toks[pos++]!;

  function parsePrimary(depth: number): ExprAst {
    if (depth > MAX_DEPTH) err("expression too deeply nested");
    const t = next();
    if (t.k === "num") return { k: "num", v: t.v };
    if (t.k === "str") return { k: "str", v: t.v };
    if (t.k === "ident") {
      if (t.v === "true") return { k: "bool", v: true };
      if (t.v === "false") return { k: "bool", v: false };
      if (t.v === "not") return { k: "un", op: "not", e: parseAt(2, depth + 1) };
      const nxt = peek();
      if (nxt.k === "op" && nxt.v === "(") {
        next();
        const arity = FN_ARITY[t.v];
        if (!arity) err(`unknown function '${t.v}'`);
        const args: ExprAst[] = [];
        if (!(peek().k === "op" && (peek() as { v: string }).v === ")")) {
          for (;;) {
            args.push(parseAt(0, depth + 1));
            const sep = next();
            if (sep.k === "op" && sep.v === ",") continue;
            if (sep.k === "op" && sep.v === ")") break;
            err("expected ',' or ')' in call");
          }
        } else next();
        if (args.length < arity.min || args.length > arity.max)
          err(`${t.v} takes ${arity.min}..${arity.max} args, got ${args.length}`);
        return { k: "call", fn: t.v, args };
      }
      return { k: "field", name: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      const e = parseAt(0, depth + 1);
      const close = next();
      if (!(close.k === "op" && close.v === ")")) err("expected ')'");
      return e;
    }
    if (t.k === "op" && t.v === "-")
      return { k: "un", op: "neg", e: parseAt(6, depth + 1) };
    err("unexpected token");
  }

  function parseAt(minBp: number, depth: number): ExprAst {
    if (depth > MAX_DEPTH) err("expression too deeply nested");
    let left = parsePrimary(depth);
    for (;;) {
      const bp = bindingPower(peek());
      if (!bp || bp.lbp <= minBp) break;
      next();
      const right = parseAt(bp.lbp, depth + 1);
      left = { k: "bin", op: bp.op, l: left, r: right };
    }
    return left;
  }

  const ast = parseAt(0, 0);
  if (peek().k !== "end") err("trailing input after expression");
  return ast;
}

// ---------- static type check ----------
const CMP_ORDERABLE: ReadonlySet<ExprType> = new Set(["number", "text", "date"]);

export function typecheckExpr(ast: ExprAst, scope: ExprScope): ExprType {
  switch (ast.k) {
    case "num": return "number";
    case "str": return "text";
    case "bool": return "bool";
    case "field": {
      const t = scope[ast.name];
      if (!t) err(`unknown field '${ast.name}'`);
      return t;
    }
    case "un": {
      const t = typecheckExpr(ast.e, scope);
      if (ast.op === "neg") {
        if (t !== "number") err("unary '-' needs a number");
        return "number";
      }
      if (t !== "bool") err("'not' needs a bool");
      return "bool";
    }
    case "bin": {
      const l = typecheckExpr(ast.l, scope);
      const r = typecheckExpr(ast.r, scope);
      switch (ast.op) {
        case "+": case "-": case "*": case "/": case "%":
          if (l !== "number" || r !== "number") err(`'${ast.op}' needs numbers`);
          return "number";
        case "==": case "!=":
          if (l !== r) err(`'${ast.op}' needs matching types`);
          return "bool";
        case "<": case "<=": case ">": case ">=":
          if (l !== r || !CMP_ORDERABLE.has(l)) err(`'${ast.op}' needs matching orderable types`);
          return "bool";
        case "and": case "or":
          if (l !== "bool" || r !== "bool") err(`'${ast.op}' needs bools`);
          return "bool";
      }
      break;
    }
    case "call": {
      const args = ast.args.map(a => typecheckExpr(a, scope));
      const all = (t: ExprType): boolean => args.every(a => a === t);
      switch (ast.fn) {
        case "min": case "max":
          if (!all("number")) err(`${ast.fn} needs numbers`);
          return "number";
        case "abs": case "round": case "floor": case "ceil":
          if (!all("number")) err(`${ast.fn} needs a number`);
          return "number";
        case "len":
          if (!all("text")) err("len needs text");
          return "number";
        case "coalesce":
          if (!args.every(a => a === args[0])) err("coalesce needs matching types");
          return args[0]!;
        case "days_between":
          if (!all("date")) err("days_between needs dates");
          return "number";
        case "if":
          if (args[0] !== "bool") err("if needs a bool condition");
          if (args[1] !== args[2]) err("if branches need matching types");
          return args[1]!;
        case "contains":
          if (!all("text")) err("contains needs text");
          return "bool";
        case "lower":
          if (!all("text")) err("lower needs text");
          return "text";
        case "concat":
          if (!args.every(a => a === "text" || a === "number")) err("concat needs text or numbers");
          return "text";
        default:
          err(`unknown function '${ast.fn}'`);
      }
    }
  }
  err("unreachable");
}

// ---------- evaluator (total for well-typed input) ----------
type Budget = { steps: number };

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

function evalNode(ast: ExprAst, row: Record<string, ExprValue>, b: Budget): ExprValue {
  if (--b.steps < 0) err("evaluation budget exceeded");
  switch (ast.k) {
    case "num": return ast.v;
    case "str": return ast.v;
    case "bool": return ast.v;
    case "field": return ast.name in row ? row[ast.name]! : null;
    case "un": {
      const v = evalNode(ast.e, row, b);
      if (v === null) return null;
      return ast.op === "neg" ? finite(-(v as number)) : !(v as boolean);
    }
    case "bin": {
      if (ast.op === "and" || ast.op === "or") {
        const l = evalNode(ast.l, row, b);
        if (ast.op === "and" && l === false) return false;
        if (ast.op === "or" && l === true) return true;
        const r = evalNode(ast.r, row, b);
        if (l === null || r === null) return null;
        return ast.op === "and" ? (l as boolean) && (r as boolean)
                                : (l as boolean) || (r as boolean);
      }
      const l = evalNode(ast.l, row, b);
      const r = evalNode(ast.r, row, b);
      if (l === null || r === null) return null;
      switch (ast.op) {
        case "+": return finite((l as number) + (r as number));
        case "-": return finite((l as number) - (r as number));
        case "*": return finite((l as number) * (r as number));
        case "/": return r === 0 ? null : finite((l as number) / (r as number));
        case "%": return r === 0 ? null : finite((l as number) % (r as number));
        case "==": return l === r;
        case "!=": return l !== r;
        case "<": return l < r;
        case "<=": return l <= r;
        case ">": return l > r;
        case ">=": return l >= r;
      }
      break;
    }
    case "call": {
      if (ast.fn === "coalesce") {
        for (const a of ast.args) {
          const v = evalNode(a, row, b);
          if (v !== null) return v;
        }
        return null;
      }
      if (ast.fn === "if") {
        const c = evalNode(ast.args[0]!, row, b);
        if (c === null) return null;
        return evalNode(c === true ? ast.args[1]! : ast.args[2]!, row, b);
      }
      const args = ast.args.map(a => evalNode(a, row, b));
      if (ast.fn === "concat")
        return args.map(v => (v === null ? "" : String(v))).join("");
      if (args.some(v => v === null)) return null;
      switch (ast.fn) {
        case "min": return finite(Math.min(...(args as number[])));
        case "max": return finite(Math.max(...(args as number[])));
        case "abs": return finite(Math.abs(args[0] as number));
        case "round": return finite(Math.round(args[0] as number));
        case "floor": return finite(Math.floor(args[0] as number));
        case "ceil": return finite(Math.ceil(args[0] as number));
        case "len": return (args[0] as string).length;
        case "lower": return (args[0] as string).toLowerCase();
        case "contains": return (args[0] as string).includes(args[1] as string);
        case "days_between": {
          const a = Date.parse(args[0] as string);
          const bb = Date.parse(args[1] as string);
          if (Number.isNaN(a) || Number.isNaN(bb)) return null;
          return Math.round((bb - a) / 86_400_000);
        }
        default: err(`unknown function '${ast.fn}'`);
      }
    }
  }
  err("unreachable");
}

export function evalExpr(
  ast: ExprAst,
  row: Record<string, ExprValue>,
  budget: number = DEFAULT_BUDGET,
): ExprValue {
  return evalNode(ast, row, { steps: budget });
}

/** Parse + typecheck in one step; the everyday entry point. */
export function compileExpr(src: string, scope: ExprScope): { ast: ExprAst; type: ExprType } {
  const ast = parseExpr(src);
  return { ast, type: typecheckExpr(ast, scope) };
}

/** Collect the field names an expression reads (for SQL select planning). */
export function exprFields(ast: ExprAst, into: Set<string> = new Set()): Set<string> {
  switch (ast.k) {
    case "field": into.add(ast.name); break;
    case "un": exprFields(ast.e, into); break;
    case "bin": exprFields(ast.l, into); exprFields(ast.r, into); break;
    case "call": for (const a of ast.args) exprFields(a, into); break;
    default: break;
  }
  return into;
}
