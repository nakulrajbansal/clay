// Build-time only. Zod remains the oracle; this module never enters production.
import { createHash } from "node:crypto";
import { datetimeRegex, z } from "zod/v3";
const automaticWrapperMap = z.string().optional()._def.errorMap.toString();

export const digest = text => createHash("sha256").update(text).digest("hex");
export function assertApprovedManifest(approved, files) {
  const keys=Object.keys(approved);
  if(keys.length!==files.length || keys.some(key=>!files.includes(key))
      || keys.some(key=>typeof approved[key]!=='string'||!/^[0-9a-f]{64}$/.test(approved[key])))
    throw new Error('Unsupported standalone input manifest');
}
export function assertApprovedSource(file, source, approved) {
  if (!Object.hasOwn(approved, file)) throw new Error(`unapproved standalone source: ${file}`);
  if (digest(source) !== approved[file]) throw new Error(`standalone source drift: ${file}`);
}
function closed(value, allowed) {
  for (const key of Reflect.ownKeys(value))
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error(`Unsupported schema AST field: ${String(key)}`);
}
function defFields(def, fields, approvedDerivedMap = false) {
  closed(def, ["typeName", "errorMap", "description", ...fields]);
  // Zod optional/nullable/default synthesize the same default map from the inner
  // definition. The inner node is separately checked; custom root maps fail.
  if (def.description !== undefined || (def.errorMap !== undefined
      && ((!def.innerType && !approvedDerivedMap) || def.errorMap.toString() !== automaticWrapperMap)))
    throw new Error("Unsupported schema error map/description");
}

/** Closed version-1 parse program. refs/hook are supplied only by the source-
 * pinned generator. No unknown Zod node/check/function has a fallback. */
export function encodeSchema(schema, options = {}, ancestry = new Set()) {
  const reference = options.reference?.(schema);
  if (reference !== undefined) return reference;
  if (ancestry.has(schema)) throw new Error("Unsupported unapproved schema recursion");
  const next = new Set(ancestry).add(schema);
  const child = s => encodeSchema(s, options, next);
  const d = schema?._def;
  if (!d || typeof d.typeName !== "string") throw new Error("Unsupported schema AST");
  const hook = options.hook?.(schema);
  switch (d.typeName) {
    case "ZodString":
    case "ZodNumber": {
      defFields(d, ["checks", "coerce"]);
      if (d.coerce) throw new Error("Unsupported coercion");
      const checks = d.checks.map(c => {
        if (["min", "max"].includes(c.kind)) {
          closed(c, ["kind", "value", "inclusive", "message"]);
          if (!Number.isFinite(c.value)) throw new Error("Unsupported non-finite bound");
          return [c.kind === "min" ? 0 : 1, c.value, c.inclusive ?? true, c.message];
        }
        if (c.kind === "length" && d.typeName === "ZodString") {
          closed(c, ["kind", "value", "message"]);
          if (!Number.isFinite(c.value)) throw new Error("Unsupported non-finite length");
          return [2, c.value, c.message];
        }
        if (c.kind === "regex" && d.typeName === "ZodString") {
          closed(c, ["kind", "regex", "message"]); return [3, c.regex, "regex", c.message];
        }
        if (c.kind === "uuid" && d.typeName === "ZodString") {
          closed(c, ["kind", "message"]);
          return [3, /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i, "uuid", c.message];
        }
        if (c.kind === "datetime" && d.typeName === "ZodString") {
          closed(c, ["kind", "precision", "offset", "local", "message"]);
          return [3, datetimeRegex(c), "datetime", c.message];
        }
        if (c.kind === "url" && d.typeName === "ZodString") {
          closed(c, ["kind", "message"]); return [4, c.message];
        }
        if (c.kind === "trim" && d.typeName === "ZodString") { closed(c, ["kind"]); return [7]; }
        if (["int", "finite"].includes(c.kind) && d.typeName === "ZodNumber") {
          closed(c, ["kind", "message"]); return [c.kind === "int" ? 5 : 6, c.message];
        }
        throw new Error(`Unsupported schema check: ${d.typeName}/${c.kind}`);
      });
      return [d.typeName === "ZodString" ? 0 : 1, checks];
    }
    case "ZodBoolean": defFields(d, ["coerce"]); if (d.coerce) throw new Error("Unsupported coercion"); return [2];
    case "ZodNull": defFields(d, []); return [3];
    case "ZodLiteral":
      defFields(d, ["value"]);
      if (d.value !== null && d.value !== undefined && !["string", "boolean", "number"].includes(typeof d.value)
          || typeof d.value === "number" && !Number.isFinite(d.value)) throw new Error("Unsupported literal");
      return [4, d.value];
    case "ZodEnum": defFields(d, ["values"], hook?.kind === "extract"); return [5, d.values];
    case "ZodObject": {
      defFields(d, ["shape", "unknownKeys", "catchall"]);
      if (!["strict", "strip", "passthrough"].includes(d.unknownKeys) || d.catchall._def.typeName !== "ZodNever")
        throw new Error("Unsupported object catchall/mode");
      return [6, Object.fromEntries(Object.entries(d.shape()).map(([key, s]) => [key, child(s)])),
        {strip:0,strict:1,passthrough:2}[d.unknownKeys]];
    }
    case "ZodArray":
      defFields(d, ["type", "minLength", "maxLength", "exactLength"]);
      for (const limit of [d.minLength, d.maxLength, d.exactLength]) if (limit) {
        closed(limit, ["value", "message"]);
        if (!Number.isFinite(limit.value)) throw new Error("Unsupported non-finite cardinality");
      }
      return [7, child(d.type), ...[d.minLength,d.maxLength,d.exactLength].map(limit => limit ? [limit.value,limit.message] : undefined)];
    case "ZodRecord": defFields(d, ["keyType", "valueType"]); return [8, child(d.keyType), child(d.valueType)];
    case "ZodTuple":
      defFields(d, ["items", "rest"]); if (d.rest) throw new Error("Unsupported tuple rest");
      return [9, d.items.map(child)];
    case "ZodUnion": defFields(d, ["options"]); return [10, d.options.map(child)];
    case "ZodDiscriminatedUnion":
      defFields(d, ["options", "optionsMap", "discriminator"]);
      return [11, d.discriminator, [...d.optionsMap].map(([key, s]) => [key, child(s)])];
    case "ZodOptional": defFields(d, ["innerType"]); return [12, child(d.innerType)];
    case "ZodNullable": defFields(d, ["innerType"]); return [13, child(d.innerType)];
    case "ZodEffects": {
      defFields(d, ["schema", "effect"]); closed(d.effect, ["type", "refinement"]);
      if(hook?.kind==='arrayBuffer'&&d.effect.type==='refinement'&&d.schema._def.typeName==='ZodAny') {
        defFields(d.schema._def,[]);return [19,hook.callback,hook.message];
      }
      if (!hook || !["refine", "superRefine"].includes(hook.kind) || d.effect.type !== "refinement")
        throw new Error("Unapproved schema refinement/transform/custom validator");
      return [hook.kind === "refine" ? 14 : 15, child(d.schema), hook.callback, hook.message];
    }
    case "ZodDefault":
      defFields(d, ["innerType", "defaultValue"]);
      if (hook?.kind !== "default") throw new Error("Unapproved schema default");
      return [16, child(d.innerType), hook.value];
    case "ZodLazy":
      defFields(d, ["getter"]);
      if (hook?.kind !== "jsonLazy") throw new Error("Unapproved lazy recursion");
      return [17, options.lazy(d.getter())];
    case "ZodUnknown": defFields(d, []); return [18];
    default: throw new Error(`Unsupported schema kind: ${d.typeName}`);
  }
}
