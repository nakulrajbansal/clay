// The API-level schema must stay inside the structured-outputs subset
// (G1/ADR-013, Q21): every object closed with additionalProperties:false,
// no type arrays (nullability via anyOf), no numeric/string constraints,
// no recursion. And the grammar must ACCEPT our canonical outputs — every
// exemplar plan validates against it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import apiSchema from "../mutation-plan-api.json";

type Node = Record<string, unknown>;

function walkObjects(node: unknown, path: string, visit: (n: Node, path: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkObjects(child, `${path}[${i}]`, visit));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  visit(node as Node, path);
  for (const [key, value] of Object.entries(node)) {
    if (key === "$comment") continue;
    walkObjects(value, `${path}.${key}`, visit);
  }
}

describe("structured-outputs subset constraints", () => {
  it("every object schema is closed; no type arrays; no unsupported keywords", () => {
    walkObjects(apiSchema, "$", (n, path) => {
      // objects may be LOOSE ({"type":"object"}, the grammar-shrinking
      // design) or CLOSED with defined properties; the only rule is that
      // additionalProperties, when present, must be false (never true).
      if ("additionalProperties" in n) {
        expect(n.additionalProperties, `${path}: additionalProperties must be false`).toBe(false);
      }
      if (n.type === "object" && n.properties) {
        expect(n.additionalProperties, `${path}: an object with properties must be closed`).toBe(false);
      }
      if ("type" in n) {
        expect(Array.isArray(n.type), `${path}: use anyOf instead of a type array`).toBe(false);
      }
      for (const banned of ["minimum", "maximum", "minLength", "maxLength",
        "multipleOf", "minItems", "maxItems", "pattern"]) {
        expect(banned in n, `${path}: '${banned}' is not in the SO subset`).toBe(false);
      }
    });
  });

  it("keeps the grammar small: migration + declared_queries are strings", () => {
    // G1/ADR-013: the variable-shape nested parts are carried as JSON
    // strings so every object can stay closed AND the grammar stays under
    // the complexity cap. Guard against a regression that re-inlines them.
    const s = apiSchema as {
      properties: Record<string, {
        anyOf?: { type?: string }[];
        items?: { properties?: Record<string, { items?: unknown }> };
      }>;
    };
    expect(s.properties.migration!.anyOf!.map(b => b.type).sort())
      .toEqual(["null", "string"]);
    expect(s.properties.panels!.items!.properties!.declared_queries!.items)
      .toEqual({ type: "string" });
  });

  it("compiles as a valid JSON schema", () => {
    const ajv = new Ajv({ strict: false });
    expect(ajv.compile(apiSchema)).toBeTypeOf("function");
  });
});

// The exemplars are written in OBJECT form (readable few-shot); the wire
// form stringifies migration + each declared_queries entry. This encodes an
// exemplar the way the model must emit it, then checks it fits the grammar.
function toWireForm(plan: Record<string, unknown>): unknown {
  const out = { ...plan };
  out.migration = out.migration == null ? null : JSON.stringify(out.migration);
  if (Array.isArray(out.panels)) {
    out.panels = out.panels.map(p => {
      const panel = { ...(p as Record<string, unknown>) };
      if (Array.isArray(panel.declared_queries))
        panel.declared_queries = panel.declared_queries.map(q => JSON.stringify(q));
      return panel;
    });
  }
  return out;
}

describe("the grammar accepts every canonical exemplar (in wire form)", () => {
  const exemplarsDir = fileURLToPath(new URL("../../../specs/exemplars/", import.meta.url));
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(apiSchema);
  const files = readdirSync(exemplarsDir).filter(f => /^(0[1-9]|1[0-2])-.*\.md$/.test(f));

  it("finds all twelve", () => expect(files).toHaveLength(12));
  for (const file of files) {
    it(file, () => {
      const md = readFileSync(join(exemplarsDir, file), "utf8");
      const json = md.match(/```json\s*\n([\s\S]*?)```/)?.[1];
      const plan = JSON.parse(json!) as Record<string, unknown>;
      const ok = validate(toWireForm(plan));
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    });
  }
});
