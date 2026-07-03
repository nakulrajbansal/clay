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
      if (n.type === "object") {
        expect(n.additionalProperties, `${path} must be closed`).toBe(false);
        expect(n.properties, `${path} must declare properties`).toBeDefined();
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
