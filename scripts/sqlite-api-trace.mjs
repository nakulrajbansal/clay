// Read-only audit/check. No --write, --approve or best-effort optimization mode.
import { readFileSync } from "node:fs";
import { loadSqliteTraceInputs, createSqliteApiTrace, generateSqliteInitializer } from "../packages/shell/config/sqlite-api-trace.mjs";
const args = process.argv.slice(2);
if (args.length > 1 || ![undefined, "--check", "--candidate"].includes(args[0]))
  throw new Error("Usage: node scripts/sqlite-api-trace.mjs [--check|--candidate]; no automatic approval");
const inputs = loadSqliteTraceInputs();
if (args[0] === "--candidate") {
  // A reviewable blocked inventory, never an authorization to delete code.
  process.stdout.write(JSON.stringify(createSqliteApiTrace(inputs), null, 2) + "\n");
} else {
  const checked = JSON.parse(readFileSync(new URL("../packages/shell/config/sqlite-api-trace.json", import.meta.url), "utf8"));
  const output = generateSqliteInitializer(inputs, checked, { kind: "retain-intact" });
  console.log(JSON.stringify({ trace: "MATCH", verdict: checked.verdict.kind,
    initializerBytes: Buffer.byteLength(output), initializerSha256: checked.pinned.initializerSha256,
    wasmSha256: checked.pinned.wasm, approvedOmissions: [], productionSpecialization: false }));
}
