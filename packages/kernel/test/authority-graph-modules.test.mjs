import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertAuthorityGraphModules } from "../../../scripts/authority-graph-module-check.mjs";
const module = { id: "packages/kernel/src/authority-graph.ts", rendered: 100 };
const chunk = {runtime:"worker",file:"assets/target-authority.js",modules:[module]};
describe("closed worker-only graph boundary", () => {
  it("requires exactly one worker graph and rejects shell, duplicates, oracles and unrecognized reports", () => {
    const report=chunks=>({kind:"build_module_diagnostic_not_certification",chunks});
    expect(()=>assertAuthorityGraphModules(report([chunk]))).not.toThrow();
    for(const bad of [report([]),report([{...chunk,runtime:"shell"}]),report([chunk,{...chunk,file:"assets/duplicate.js"}]),
      report([chunk,{runtime:"worker",file:"assets/oracle.js",modules:[{id:"packages/kernel/test/oracles/device-catalog.ts",rendered:1}]}]),{}])
      expect(()=>assertAuthorityGraphModules(bad)).toThrow();
  });
  it("pins independent pre-refactor readers; their only relocation is to test imports", () => {
    for (const [name,expected] of [
      ["device-catalog","c5603ad2560bcacaa7dd68bec88e4f710bb33738b251a8ee30d95e5e9fd61199"],
      ["archive-authority","bfbc12fda0eb7f380ef10d4df6b8bb2c55a20612b9002017d91580b995bcc5cf"],
    ]) expect(createHash("sha256").update(readFileSync(new URL(`./oracles/${name}.ts`,import.meta.url),"utf8").replaceAll("\r\n","\n")).digest("hex")).toBe(expected);
  });
  it("keeps the graph free of runtime schema factories, I/O, raw commands and package barrel imports", () => {
    const text=readFileSync(new URL("../src/authority-graph.ts",import.meta.url),"utf8");
    expect(text.match(/^import (?!type).*from .+$/gm)).toEqual(['import { ClayError } from "./errors";']);
    expect(/\b(?:eval|fetch|exec|select|postMessage|new Function)\s*\(/.test(text)).toBe(false);
  });
});
