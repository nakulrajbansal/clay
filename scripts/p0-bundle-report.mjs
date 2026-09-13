// Supplement the frozen fail-fast gate with measurements of ALL three known red boundaries.
// This does not replace scripts/bundle-budget.mjs or change any of its limits.
import { readdir, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { collectAssetJavaScriptClosure, collectEmittedRuntimeFiles, measureFiles } from "./bundle-budget-lib.mjs";
const dist = fileURLToPath(new URL("../packages/shell/dist/", import.meta.url));
const panel = fileURLToPath(new URL("../packages/panel-runtime/dist/", import.meta.url));
const assets = await readdir(new URL("../packages/shell/dist/assets/", import.meta.url));
const one = pattern => {
  const matches = assets.filter(name => pattern.test(name));
  if (matches.length !== 1) throw new Error("production asset identity is ambiguous");
  return `assets/${matches[0]}`;
};
const authority = await measureFiles(dist, [one(/^worker-authority-[^.]+\.js$/)]);
const worker = await measureFiles(dist, await collectAssetJavaScriptClosure(dist, one(/^db-worker-[^.]+\.js$/)));
const emitted = await measureFiles(dist, await collectEmittedRuntimeFiles(dist));
const iframe = await measureFiles(panel, ["panel-runtime.iife.js"]);
const browser = { raw: emitted.raw + iframe.raw, gzip: emitted.gzip + iframe.gzip,
  files: [...emitted.files, ...iframe.files] };
const boundaries = Object.entries({
  workerAuthority: { ...authority, limits: { raw: 240_000, gzip: 60_000 } },
  completeWorker: { ...worker, limits: { raw: 1_010_000, gzip: 280_000 } },
  completeBrowser: { ...browser, limits: { raw: 3_250_000, gzip: 1_100_000 } },
}).map(([name, data]) => ({ name, ...data, passed: data.raw <= data.limits.raw && data.gzip <= data.limits.gzip }));
const report = { schema: 1, frozenGateSha256: createHash("sha256")
  .update(await readFile(new URL("bundle-budget.mjs", import.meta.url))).digest("hex"), boundaries };
const directory = new URL("../evidence/p0-verification/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("bundles.json", directory), JSON.stringify(report, null, 2));
for (const { name, raw, gzip, limits, passed } of boundaries)
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${raw} raw / ${gzip} gzip; frozen ${limits.raw} / ${limits.gzip}`);
if (boundaries.some(boundary => !boundary.passed)) process.exitCode = 1;
