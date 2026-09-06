import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "../src/app");
const source = (name: string): string => fs.readFileSync(path.join(appRoot, name), "utf8");

describe("table import surface", () => {
  it("describes only supported text data formats, never spreadsheet files", () => {
    const importSurface = `${source("App.tsx")}\n${source("DataView.tsx")}`;
    expect(importSurface).not.toMatch(/(?:upload|import|download[^\n]*) (?:a |as a )?spreadsheet/i);
    expect(importSurface).not.toMatch(/\.xlsx?|\.ods/i);
    expect(importSurface).toMatch(/CSV, TSV, or JSON data file/i);
  });
});
