// Read-only source-bound manifest generator. --candidate prints reviewed data;
// build/test never silently accepts a new starter, fragment or input hash.
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(await realpath(new URL("../packages/shell/node_modules/vite/package.json", import.meta.url)));
const { build } = require("esbuild");
const sources = ["packages/shell/src/shells/seed.ts", "packages/shell/src/shells/seed-panels.ts"];
const hash = text => createHash("sha256").update(text).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const outfile = resolve(root, "test-results/fix-batch/seed-manifest-input.mjs");
await build({ entryPoints: [resolve(root, sources[0])], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" });
const { STARTER_SHELLS, createStarterSeedBundle } = await import(pathToFileURL(outfile).href);
const fragments = {}, inputs = {};
for (const path of sources) inputs[path] = hash((await readFile(resolve(root, path), "utf8")).replaceAll("\r\n", "\n"));
for (const { id } of STARTER_SHELLS) {
  if (Object.hasOwn(fragments, id)) throw new Error("Duplicate starter identity");
  const bundle = createStarterSeedBundle(id);
  const json = canonical(bundle);
  const bytes = Buffer.byteLength(json);
  if (bytes > 900_000) throw new Error("Oversized starter fragment");
  if (Buffer.byteLength(JSON.stringify(bundle)) !== bytes) throw new Error("Unexpected wire byte length");
  fragments[id] = { bytes, sha256: hash(json), wireSha256: hash(JSON.stringify(bundle)) };
}
const candidate = { version: 1, inputs, fragments };
if (process.argv.length !== 3 || !["--check", "--candidate"].includes(process.argv[2])) throw new Error("Expected --check or --candidate");
if (process.argv[2] === "--candidate") console.log(JSON.stringify(candidate, null, 2));
else {
  const expected = JSON.parse(await readFile(resolve(root, "packages/shell/src/worker/seed-manifest.json"), "utf8"));
  if (JSON.stringify(candidate) !== JSON.stringify(expected)) throw new Error("Starter manifest drift; explicit review required");
  console.log(`PASS source-bound starter manifest: ${Object.keys(fragments).length} exact fragments`);
}
