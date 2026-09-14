import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClosedBlueprintDirective } from "../src/blueprint-contract";

describe("packaged product gate model fixtures", () => {
  it.each(["change-contract", "provider-connections"])("%s respects the production declarative-only boundary", script => {
    const source = readFileSync(new URL(`../../../scripts/${script}.mjs`, import.meta.url), "utf8");
    const codes = [...source.matchAll(/\bcode:\s*("(?:\\.|[^"\\])*")/g)]
      .map(match => JSON.parse(match[1]!) as string);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const directive = parseClosedBlueprintDirective(code);
      expect(directive, "new model output may not contain executable JavaScript").not.toBeNull();
      expect(directive?.table).toBe("deals");
    }
  });
});
