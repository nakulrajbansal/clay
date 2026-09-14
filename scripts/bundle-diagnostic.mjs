// Full diagnostic for the collected red boundaries, using the frozen gate's
// exact collectors and limits. Never overwrites release evidence or replaces the
// fail-fast bundle-budget.mjs gate (which must still be run separately).
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { analyzeManifest, collectAssetJavaScriptClosure, collectEmittedRuntimeFiles,
  measureFiles, mergeFiles } from "./bundle-budget-lib.mjs";
const dist = fileURLToPath(new URL("../packages/shell/dist/", import.meta.url));
const panel = fileURLToPath(new URL("../packages/panel-runtime/dist/", import.meta.url));
const assets = await readdir(`${dist}/assets`);
const one = pattern => {
  const matches = assets.filter(name => pattern.test(name));
  if (matches.length !== 1) throw new Error("Ambiguous diagnostic artifact identity");
  return `assets/${matches[0]}`;
};
const manifest = JSON.parse(await readFile(`${dist}/.vite/manifest.json`, "utf8"));
const analysis = analyzeManifest(manifest, { expectedLazyChunks: [
  ...["PanelFrame", "DataView", "ExportDialog", "RecordDetail", "RelationConversionDialog",
    "CommandPalette", "AutomationCenter", "HistoryView", "ShapeMapView", "PrivateMetricsView"]
    .map(label => ({ label, source: `src/app/${label}.tsx` })),
  { label: "ProductionBackupRuntime", source: "src/app/production-backup.browser.ts" },
  { label: "AutomaticBackupTrigger", source: "src/app/automatic-backup-trigger.browser.ts" },
] });
const emitted = await measureFiles(dist, await collectEmittedRuntimeFiles(dist));
const iframe = await measureFiles(panel, ["panel-runtime.iife.js"]);
const panelChunk = analysis.lazyChunks.find(chunk => chunk.label === "PanelFrame");
const lazyLimits = { PanelFrame: { raw: 135_000, gzip: 35_000 },
  RecordDetail: { raw: 50_000, gzip: 16_000 }, ExportDialog: { raw: 24_000, gzip: 8_000 } };
const measurements = [
  ["staticEntry", await measureFiles(dist, analysis.entryClosure.files), { raw: 770_000, gzip: 232_000 }],
  ["bootCritical", await measureFiles(dist, mergeFiles(analysis.entryClosure.files, panelChunk.closure.files)), { raw: 875_000, gzip: 260_000 }],
  ...await Promise.all(analysis.lazyChunks.map(async chunk => [chunk.label,
    await measureFiles(dist, chunk.closure.files), lazyLimits[chunk.label] ?? { raw: 45_000, gzip: 14_000 }])),
  ["totalShellJavaScript", await measureFiles(dist, analysis.totalShellJsFiles), { raw: 980_000, gzip: 290_000 }],
  ["databaseWorker", await measureFiles(dist, [one(/^db-worker-[^.]+\.js$/)]), { raw: 765_000, gzip: 220_000 }],
  ["workerAuthority", await measureFiles(dist, [one(/^worker-authority-[^.]+\.js$/)]), { raw: 240_000, gzip: 60_000 }],
  ["plannerChunks", await measureFiles(dist, [one(/^planner-pipeline-entry-[^.]+\.js$/), one(/^planner-authority-[^.]+\.js$/)]), { raw: 30_000, gzip: 10_000 }],
  ["completeWorker", await measureFiles(dist, await collectAssetJavaScriptClosure(dist, one(/^db-worker-[^.]+\.js$/))), { raw: 1_010_000, gzip: 280_000 }],
  ["sqliteSupportWorkers", await measureFiles(dist, [one(/^sqlite3-worker1-[^.]+\.js$/), one(/^sqlite3-opfs-async-proxy-[^.]+\.js$/)]), { raw: 270_000, gzip: 90_000 }],
  ["sqliteWasm", await measureFiles(dist, [one(/^sqlite3-[^.]+\.wasm$/)]), { raw: 900_000, gzip: 420_000 }],
  ["panelBootstrap", iframe, { raw: 82_000, gzip: 21_000 }],
  ["applicationStyles", await measureFiles(dist, mergeFiles(...Object.values(manifest).map(record => [
    ...(record.file?.endsWith(".css") ? [record.file] : []), ...(record.css ?? []),
  ]))), { raw: 67_000, gzip: 17_000 }],
  ["completeBrowser", { raw: emitted.raw + iframe.raw, gzip: emitted.gzip + iframe.gzip,
    files: [...emitted.files, ...iframe.files] }, { raw: 3_250_000, gzip: 1_100_000 }],
];
const boundaries = measurements.map(([name, measured, limits]) => ({ name, ...measured, limits,
  passed: measured.raw <= limits.raw && measured.gzip <= limits.gzip }));
const report = { kind: "bundle_diagnostic_not_certification", frozenGateSha256: createHash("sha256")
  .update(await readFile(new URL("bundle-budget.mjs", import.meta.url))).digest("hex"), boundaries };
const output = new URL("../test-results/fix-batch/", import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL("bundles.json", output), JSON.stringify(report, null, 2));
for (const { name, raw, gzip, limits, passed } of boundaries)
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${raw} raw / ${gzip} gzip; frozen ${limits.raw} / ${limits.gzip}`);
if (boundaries.some(boundary => !boundary.passed)) process.exitCode = 1;
