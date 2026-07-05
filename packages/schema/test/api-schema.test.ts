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

  it("keeps the compiled grammar small: loose objects for ops and queries", () => {
    // G1/ADR-013: migration ops, queries, and placement must stay loose so
    // the API's grammar-complexity cap is not tripped. Guard against a
    // regression that re-introduces deep typed unions here.
    const s = apiSchema as { properties: Record<string, { anyOf?: { properties?: Record<string, { items?: unknown }> }[] }> };
    const migObj = s.properties.migration!.anyOf!.find(b => b.properties)!;
    expect(migObj.properties!.operations!.items).toEqual({ type: "object" });
    expect(migObj.properties!.inverse!.items).toEqual({ type: "object" });
  });

  it("compiles as a valid JSON schema", () => {
    const ajv = new Ajv({ strict: false });
    expect(ajv.compile(apiSchema)).toBeTypeOf("function");
  });
});

describe("the grammar accepts every canonical exemplar plan", () => {
  const exemplarsDir = fileURLToPath(new URL("../../../specs/exemplars/", import.meta.url));
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(apiSchema);
  const files = readdirSync(exemplarsDir).filter(f => /^(0[1-9]|10)-.*\.md$/.test(f));

  it("finds all ten", () => expect(files).toHaveLength(10));
  for (const file of files) {
    it(file, () => {
      const md = readFileSync(join(exemplarsDir, file), "utf8");
      const json = md.match(/```json\s*\n([\s\S]*?)```/)?.[1];
      const plan = JSON.parse(json!) as unknown;
      const ok = validate(plan);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    });
  }
});
