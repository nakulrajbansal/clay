import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import raw from "@clay/schema/mutation-plan-api.json";
import { WIRE_SCHEMA, WIRE_SCHEMA_SOURCE_SHA256 } from "../src/wire-schema.gen";

// Independent reference: the exact former runtime algorithm, not the generator.
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) if (key !== "$comment") out[key] = strip(value);
    return out;
  }
  return node;
}
it("precomputes only discarded API annotations; the transmitted closed schema is object-identical", () => {
  expect(WIRE_SCHEMA).toEqual(strip(raw));
  const bytes = readFileSync(new URL("../../schema/mutation-plan-api.json", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  expect(WIRE_SCHEMA_SOURCE_SHA256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(JSON.stringify(WIRE_SCHEMA)).not.toContain('"$comment"');
  expect(WIRE_SCHEMA).toHaveProperty("additionalProperties", false);
});
