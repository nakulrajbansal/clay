// Validator (doc 06 §5): static, pre-execution checks V1–V7 over a full
// MutationPlan. Failures are machine-readable — the same strings feed the
// repair prompt (doc 05 §1) and the rejection log.
//
// V4 static scope: object LITERALS passed to db.query/db.watch (directly or
// via a same-name const) must match a declared query; dynamic query values
// match only {"$var": true} declarations; queries built dynamically pass
// statically and are enforced at the Bridge (runtime V4). Write calls'
// table argument must be a string literal in declared_writes (G22/ADR-014).
import * as acorn from "acorn";
import { MutationPlan as MutationPlanSchema } from "@clay/schema";
import type { z } from "zod";
import { ClayError } from "./errors";
import { validateMigrationPlan } from "./migrate";
import { getTable, resolveField, type Registry } from "./registry";

type MutationPlanT = z.infer<typeof MutationPlanSchema>;
type PanelT = MutationPlanT["panels"][number];
type QueryT = import("@clay/schema").Query;
type DiffKind = MutationPlanT["user_facing_diff"][number]["kind"];

export type ValidationIssue = { rule: string; panel?: string; message: string };

export type ValidatorContext = {
  registry: Registry;
  /** ids of currently live panels (reuse = replace, G11) */
  livePanelIds: string[];
};

// ---------- V2 forbidden identifiers (doc 06 §5, verbatim) ----------
const FORBIDDEN = new Set([
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator",
  "window", "document", "globalThis", "self", "top", "parent", "frames",
  "location", "history", "localStorage", "sessionStorage", "indexedDB",
  "caches", "cookie", "import", "eval", "Function", "setTimeout",
  "setInterval", "postMessage", "Worker", "SharedArrayBuffer", "Atomics",
  "WebAssembly", "Proxy", "Reflect", "constructor", "__proto__", "prototype",
]);

const MAX_AST_DEPTH = 40;
const MAX_STRING = 4096;

type AnyNode = acorn.Node & Record<string, unknown>;

const isNode = (v: unknown): v is AnyNode =>
  typeof v === "object" && v !== null && typeof (v as AnyNode).type === "string";

/** The marker for values V4 cannot resolve statically. */
const DYNAMIC: unique symbol = Symbol("dynamic");
type Extracted = string | number | boolean | null | typeof DYNAMIC
  | Extracted[] | { [k: string]: Extracted };

function extractValue(node: AnyNode): Extracted {
  switch (node.type) {
    case "Literal": {
      const v = (node as unknown as { value: unknown }).value;
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
        ? v : DYNAMIC;
    }
    case "TemplateLiteral": {
      const n = node as unknown as { expressions: unknown[]; quasis: { value: { cooked?: string } }[] };
      return n.expressions.length === 0 ? (n.quasis[0]?.value.cooked ?? DYNAMIC) : DYNAMIC;
    }
    case "UnaryExpression": {
      const n = node as unknown as { operator: string; argument: AnyNode };
      const inner = extractValue(n.argument);
      return n.operator === "-" && typeof inner === "number" ? -inner : DYNAMIC;
    }
    case "ObjectExpression": {
      const out: { [k: string]: Extracted } = {};
      for (const raw of (node as unknown as { properties: AnyNode[] }).properties) {
        if (raw.type !== "Property") return DYNAMIC;   // spread etc.
        const p = raw as unknown as { computed: boolean; key: AnyNode; value: AnyNode };
        if (p.computed) return DYNAMIC;
        const key = p.key.type === "Identifier"
          ? (p.key as unknown as { name: string }).name
          : p.key.type === "Literal" ? String((p.key as unknown as { value: unknown }).value) : null;
        if (key === null) return DYNAMIC;
        out[key] = extractValue(p.value);
      }
      return out;
    }
    case "ArrayExpression": {
      const elements = (node as unknown as { elements: (AnyNode | null)[] }).elements;
      return elements.map(e => (e ? extractValue(e) : DYNAMIC));
    }
    default:
      return DYNAMIC;
  }
}

/** exec (with DYNAMIC leaves) vs declared (with {$var:true} wildcards). */
function matchesDeclared(exec: Extracted, declared: unknown): boolean {
  if (typeof declared === "object" && declared !== null && !Array.isArray(declared)
      && (declared as Record<string, unknown>).$var === true)
    return exec !== undefined;                        // any value, incl. DYNAMIC
  if (exec === DYNAMIC) return false;                 // dynamic needs a $var slot
  if (Array.isArray(declared) || Array.isArray(exec)) {
    if (!Array.isArray(declared) || !Array.isArray(exec)) return false;
    if (declared.length !== exec.length) return false;
    return declared.every((d, i) => matchesDeclared(exec[i]!, d));
  }
  if (typeof declared === "object" && declared !== null) {
    if (typeof exec !== "object" || exec === null) return false;
    const keys = new Set([...Object.keys(declared), ...Object.keys(exec)]);
    for (const k of keys) {
      if (!matchesDeclared((exec as Record<string, Extracted>)[k]!,
        (declared as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return exec === declared;
}

// ---------- per-panel code checks (V1–V4, V6) ----------
function checkPanelCode(panel: PanelT): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (rule: string, message: string): void => {
    issues.push({ rule, panel: panel.panel_id, message });
  };

  let ast: AnyNode;
  try {
    ast = acorn.parse(panel.code, { ecmaVersion: 2023, sourceType: "module" }) as unknown as AnyNode;
  } catch (e) {
    issue("V1", `parse error: ${String(e)}`);
    return issues;
  }

  // V1: exactly one export default function of arity 1; no other im/exports
  const body = (ast as unknown as { body: AnyNode[] }).body;
  const defaults = body.filter(n => n.type === "ExportDefaultDeclaration");
  if (defaults.length !== 1) issue("V1", "module needs exactly one export default");
  for (const n of body) {
    if (n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration"
        || n.type === "ExportAllDeclaration")
      issue("V1", `panels may not use ${n.type}`);
  }
  const decl = defaults[0]
    ? (defaults[0] as unknown as { declaration: AnyNode }).declaration : null;
  if (decl) {
    const isFn = decl.type === "FunctionDeclaration" || decl.type === "FunctionExpression"
      || decl.type === "ArrowFunctionExpression";
    const params = isFn ? (decl as unknown as { params: unknown[] }).params : [];
    if (!isFn || params.length !== 1)
      issue("V1", "default export must be a function of arity 1");
  }

  // prepass for V4 const resolution: single, unreassigned `const q = {...}`
  const constObjects = new Map<string, AnyNode | null>();   // null = ambiguous
  const dbCalls: { method: string; arg0: AnyNode | undefined }[] = [];

  const seenV2 = new Set<string>();
  const walk = (node: AnyNode, depth: number): void => {
    if (depth > MAX_AST_DEPTH) {
      if (!seenV2.has("depth")) {
        seenV2.add("depth");
        issue("V6", `AST depth exceeds ${MAX_AST_DEPTH}`);
      }
      return;
    }
    switch (node.type) {
      case "Identifier": case "PrivateIdentifier": {
        const name = (node as unknown as { name: string }).name;
        if (FORBIDDEN.has(name) && !seenV2.has(name)) {
          seenV2.add(name);
          issue("V2", `forbidden identifier '${name}'`);
        }
        break;
      }
      case "ImportExpression":
        issue("V2", "dynamic import()");
        break;
      case "MemberExpression": {
        const m = node as unknown as { computed: boolean; object: AnyNode; property: AnyNode };
        if (m.computed && m.object.type === "Identifier"
            && (m.object as unknown as { name: string }).name === "clay")
          issue("V3", "computed access on clay (clay[x]) is forbidden");
        if (m.computed && m.property.type === "Literal") {
          const v = (m.property as unknown as { value: unknown }).value;
          if (typeof v === "string" && FORBIDDEN.has(v))
            issue("V3", `computed access to '${v}'`);
        }
        break;
      }
      case "Literal": {
        const v = (node as unknown as { value: unknown }).value;
        if (typeof v === "string" && v.length > MAX_STRING)
          issue("V6", `string literal over ${MAX_STRING} bytes`);
        break;
      }
      case "TemplateElement": {
        const v = (node as unknown as { value: { cooked?: string } }).value.cooked;
        if (v && v.length > MAX_STRING)
          issue("V6", `template chunk over ${MAX_STRING} bytes`);
        break;
      }
      case "VariableDeclarator": {
        const d = node as unknown as { id: AnyNode; init: AnyNode | null };
        if (d.id.type === "Identifier" && d.init?.type === "ObjectExpression") {
          const name = (d.id as unknown as { name: string }).name;
          constObjects.set(name, constObjects.has(name) ? null : d.init);
        }
        break;
      }
      case "AssignmentExpression": {
        const a = node as unknown as { left: AnyNode };
        if (a.left.type === "Identifier")
          constObjects.set((a.left as unknown as { name: string }).name, null);
        break;
      }
      case "CallExpression": {
        const c = node as unknown as { callee: AnyNode; arguments: AnyNode[] };
        const callee = c.callee as unknown as {
          type: string; computed?: boolean; object?: AnyNode; property?: AnyNode;
        };
        if (callee.type === "MemberExpression" && !callee.computed
            && callee.property?.type === "Identifier") {
          const method = (callee.property as unknown as { name: string }).name;
          const obj = callee.object as unknown as {
            type: string; computed?: boolean; object?: AnyNode; property?: AnyNode;
          } | undefined;
          const isClayDb = obj?.type === "MemberExpression" && !obj.computed
            && obj.object?.type === "Identifier"
            && (obj.object as unknown as { name: string }).name === "clay"
            && obj.property?.type === "Identifier"
            && (obj.property as unknown as { name: string }).name === "db";
          if (isClayDb) dbCalls.push({ method, arg0: c.arguments[0] });
        }
        break;
      }
      default: break;
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (isNode(value)) walk(value, depth + 1);
      else if (Array.isArray(value))
        for (const item of value) if (isNode(item)) walk(item, depth + 1);
    }
  };
  walk(ast, 0);

  // V4: query/watch literals vs declared_queries; write tables vs declared_writes
  for (const call of dbCalls) {
    if (call.method === "query" || call.method === "watch") {
      let objNode: AnyNode | null = null;
      if (call.arg0?.type === "ObjectExpression") objNode = call.arg0;
      else if (call.arg0?.type === "Identifier") {
        objNode = constObjects.get((call.arg0 as unknown as { name: string }).name) ?? null;
      }
      if (!objNode) continue;   // dynamic: the Bridge enforces at runtime
      const exec = extractValue(objNode);
      if (exec === DYNAMIC) continue;
      if (!panel.declared_queries.some(d => matchesDeclared(exec, d)))
        issue("V4", `db.${call.method} query does not match any declared_queries entry`);
    }
    if (call.method === "insert" || call.method === "update" || call.method === "softDelete") {
      const table = call.arg0 && call.arg0.type === "Literal"
        ? (call.arg0 as unknown as { value: unknown }).value : DYNAMIC;
      if (typeof table !== "string")
        issue("V4", `db.${call.method} table must be a string literal (G22)`);
      else if (!panel.declared_writes.includes(table))
        issue("V4", `db.${call.method} table '${table}' is not in declared_writes (G22)`);
    }
  }

  return issues;
}

// ---------- declared query/write sanity against the post-migration registry ----------
function collectQueryFields(q: QueryT): string[] {
  const fields: string[] = [];
  for (const c of q.where ?? []) fields.push(c.field);
  for (const g of q.orWhere ?? []) for (const c of g) fields.push(c.field);
  for (const o of q.orderBy ?? []) fields.push(o.field);
  for (const g of q.groupBy ?? []) fields.push(g);
  for (const a of q.aggregate ?? []) fields.push(a.field);
  for (const s of q.select ?? []) fields.push(s);
  return fields;
}

function checkDeclarations(panel: PanelT, reg: Registry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const q of panel.declared_queries) {
    try {
      const t = getTable(reg, q.from);
      for (const f of collectQueryFields(q)) resolveField(t, f);
    } catch (e) {
      issues.push({ rule: "V4", panel: panel.panel_id,
        message: `declared query invalid: ${e instanceof ClayError ? e.message : String(e)}` });
    }
  }
  for (const table of panel.declared_writes) {
    if (!reg.has(table))
      issues.push({ rule: "V4", panel: panel.panel_id,
        message: `declared_writes table '${table}' does not exist` });
  }
  return issues;
}

// ---------- V7: diff honesty (G24 mapping) ----------
function checkDiffHonesty(plan: MutationPlanT, liveIds: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = plan.user_facing_diff.map(d => d.kind);
  const used = lines.map(() => false);
  const claim = (kinds: DiffKind[], desc: string): void => {
    const i = lines.findIndex((k, idx) => !used[idx] && kinds.includes(k));
    if (i >= 0) used[i] = true;
    else issues.push({ rule: "V7",
      message: `${desc} has no user_facing_diff line of kind [${kinds.join("|")}]` });
  };
  for (const op of plan.migration?.operations ?? []) {
    switch (op.op) {
      case "create_table": claim(["add_field"], `create_table ${op.table}`); break;
      case "add_column":
        claim(op.column.type === "enum" ? ["add_status", "add_field"] : ["add_field"],
          `add_column ${op.table}.${op.column.name}`);
        break;
      case "rename_column": claim(["change_field"], `rename ${op.from}->${op.to}`); break;
      case "add_enum_value":
        claim(["add_status", "change_field"], `add_enum_value ${op.column}`); break;
      case "create_computed": claim(["add_computed"], `create_computed ${op.column}`); break;
      case "update_computed":
        claim(["change_field", "add_computed"], `update_computed ${op.column}`); break;
      case "hide_column": claim(["change_field"], `hide_column ${op.column}`); break;
      case "set_required": claim(["change_field"], `set_required ${op.column}`); break;
      case "backfill": case "add_index": break;   // exempt (G24)
    }
  }
  for (const p of plan.panels) {
    if (liveIds.has(p.panel_id)) claim(["change_panel"], `panel ${p.panel_id} (replaced)`);
    else claim(["add_panel", "add_chart"], `panel ${p.panel_id} (new)`);
  }
  for (const id of plan.remove_panels) claim(["remove_panel"], `remove_panels ${id}`);
  return issues;
}

/**
 * The full static validation pass (doc 05 S3). Returns machine-readable
 * issues; an empty array means the plan may proceed to the shadow dry-run.
 */
export function validateMutationPlan(planRaw: unknown, ctx: ValidatorContext): ValidationIssue[] {
  const parsed = MutationPlanSchema.safeParse(planRaw);
  if (!parsed.success) {
    return parsed.error.issues.map(i => ({
      rule: "SCHEMA", message: `${i.path.join(".")}: ${i.message}`,
    }));
  }
  const plan = parsed.data;
  if (plan.clarifying_question) return [];

  const issues: ValidationIssue[] = [];

  // V5: migration vocabulary + invariants; yields the post-migration registry
  let postReg = ctx.registry;
  if (plan.migration) {
    try {
      postReg = validateMigrationPlan(plan.migration, ctx.registry);
    } catch (e) {
      issues.push({ rule: "V5",
        message: e instanceof ClayError ? e.message : String(e) });
    }
  }

  // G11: in-plan panel id uniqueness
  const seen = new Set<string>();
  for (const p of plan.panels) {
    if (seen.has(p.panel_id))
      issues.push({ rule: "G11", panel: p.panel_id, message: "duplicate panel_id in plan" });
    seen.add(p.panel_id);
  }

  for (const p of plan.panels) {
    issues.push(...checkPanelCode(p));
    issues.push(...checkDeclarations(p, postReg));
  }

  const liveIds = new Set(ctx.livePanelIds);
  for (const id of plan.remove_panels) {
    if (!liveIds.has(id))
      issues.push({ rule: "G11", panel: id, message: "remove_panels id is not a live panel" });
  }

  issues.push(...checkDiffHonesty(plan, liveIds));
  return issues;
}

export { FORBIDDEN as FORBIDDEN_IDENTIFIERS };
