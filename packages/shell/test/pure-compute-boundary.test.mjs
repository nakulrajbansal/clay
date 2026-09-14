import { expect, it } from "vitest";
import { assertPureComputeModules, assertComputeSource } from "../config/pure-compute-boundary.mjs";
import { execFileSync } from "node:child_process";

it("fails closed on network/storage/DB authority and executable escapes", () => {
  const good = ["packages/shell/src/worker/pure-compute.ts", "packages/kernel/src/strict-json-capture.ts"];
  expect(() => assertPureComputeModules(good)).not.toThrow();
  for (const forbidden of ["packages/kernel/src/db.ts", "packages/kernel/src/store.ts",
    "packages/kernel/src/target-authority.ts", "packages/shell/src/app/worker-client.ts",
    "packages/mutation/src/client.ts", "packages/schema/src/standalone/unreviewed.mjs", "node_modules/unreviewed/index.js"])
    expect(() => assertPureComputeModules([...good, forbidden])).toThrow(/pure computation/);
  for (const source of ['fetch("/secret")', 'globalThis["fetch"]("/secret")', 'self["fetch"]("x")', 'navigator.storage.getDirectory()',
    'indexedDB.open("x")', 'new WebSocket("x")', 'Function("x")()', 'Reflect.get(globalThis,"fetch")("x")'])
    expect(() => assertComputeSource(source)).toThrow(/pure computation/);
  expect(() => assertComputeSource('const panel = { code: "fetch() is text, not a capability" };')).not.toThrow();
  expect(() => assertComputeSource('const scope = self;', "private-entry")).toThrow();
  expect(() => assertComputeSource('self["fetch"]("x");', "private-entry")).toThrow();
  expect(() => assertComputeSource('self.onmessage = () => self.close();', "private-entry")).not.toThrow();
});
it("checks the finite starter language against exact current source and bytes", () => {
  const root = new URL("../../../", import.meta.url);
  expect(execFileSync(process.execPath, ["scripts/seed-manifest.mjs", "--check"], { cwd: root, encoding: "utf8" }))
    .toContain("16 exact fragments");
});
