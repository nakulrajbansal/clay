import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main.tsx"), "utf8");

describe("public intake entry boundary", () => {
  it("loads the public form through a dynamic chunk instead of every owner app boot", () => {
    expect(source).not.toMatch(/^import\s+\{\s*PublicIntakePage\s*\}\s+from/m);
    expect(source).toMatch(/lazy\(\(\)\s*=>\s*import\("\.\/intake\/PublicIntakeForm"\)/);
  });
});
