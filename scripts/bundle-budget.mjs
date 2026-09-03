// Production bundle guard. Vite's manifest is the source of truth so hashed
// filenames and code splitting cannot hide shell growth from the release gate.
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeManifest,
  assertBuildFresh,
  assertWithinBudget,
  measureFiles,
  mergeFiles,
} from "./bundle-budget-lib.mjs";

const distRoot = fileURLToPath(
  new URL("../packages/shell/dist/", import.meta.url),
);
const panelRuntimeRoot = fileURLToPath(
  new URL("../packages/panel-runtime/dist/", import.meta.url),
);
const sourceRoot = fileURLToPath(
  new URL("../packages/shell/src/app/", import.meta.url),
);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(distRoot, ".vite", "manifest.json"), "utf8"),
);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function newestMtime(paths) {
  let newest = 0;
  async function visit(path) {
    const info = await stat(path);
    if (!info.isDirectory()) { newest = Math.max(newest, info.mtimeMs); return; }
    for (const entry of await readdir(path, { withFileTypes: true }))
      await visit(join(path, entry.name));
  }
  for (const path of paths) await visit(path);
  return newest;
}

const newestSource = await newestMtime([
  "schema", "kernel", "mutation", "panel-runtime", "shell",
].map(name => join(projectRoot, "packages", name, "src")));
const oldestArtifact = Math.min(
  (await stat(join(distRoot, ".vite", "manifest.json"))).mtimeMs,
  (await stat(join(panelRuntimeRoot, "panel-runtime.iife.js"))).mtimeMs,
);
assertBuildFresh("production bundle freshness", newestSource, oldestArtifact);
console.log("PASS production bundle freshness: generated artifacts are current");

// PanelCanvas is the intended controller-decomposition boundary. PanelFrame is
// accepted while that extraction is landing; once PanelCanvas exists it is
// mandatory. Settings follows the same create-then-require transition.
const panelBoundary = await exists(join(sourceRoot, "PanelCanvas.tsx"))
  ? { label: "PanelCanvas", source: "src/app/PanelCanvas.tsx" }
  : { label: "PanelFrame", source: "src/app/PanelFrame.tsx" };
const expectedLazyChunks = [
  panelBoundary,
  { label: "DataView", source: "src/app/DataView.tsx" },
  { label: "RecordDetail", source: "src/app/RecordDetail.tsx" },
  { label: "RelationConversionDialog", source: "src/app/RelationConversionDialog.tsx" },
  { label: "CommandPalette", source: "src/app/CommandPalette.tsx" },
  { label: "AutomationCenter", source: "src/app/AutomationCenter.tsx" },
  { label: "HistoryView", source: "src/app/HistoryView.tsx" },
  { label: "ShapeMapView", source: "src/app/ShapeMapView.tsx" },
  { label: "PrivateMetricsView", source: "src/app/PrivateMetricsView.tsx" },
];
if (await exists(join(sourceRoot, "SettingsPanel.tsx"))) {
  expectedLazyChunks.push({
    label: "SettingsPanel",
    source: "src/app/SettingsPanel.tsx",
  });
}

const analysis = analyzeManifest(manifest, { expectedLazyChunks });

function printAndAssert(label, measured, limits) {
  console.log(`${label}:`);
  for (const file of measured.files) {
    console.log(`  ${file.file}: ${file.raw} B raw / ${file.gzip} B gzip`);
  }
  assertWithinBudget(label, measured, limits);
  console.log(
    `PASS ${label}: ${measured.raw} B raw / ${measured.gzip} B gzip `
    + `(limit ${limits.raw} B / ${limits.gzip} B)`,
  );
}

async function check(label, files, limits) {
  const measured = await measureFiles(distRoot, files);
  printAndAssert(label, measured, limits);
  return measured;
}
async function checkAt(root, label, files, limits) {
  const measured = await measureFiles(root, files);
  printAndAssert(label, measured, limits);
  return measured;
}

// Connected records, global workbench, bounded automations, and local files
// add trusted behavior mostly in lazy chunks and the DB worker. These limits
// retain 2–5% headroom over the measured four-release production artifacts.
const entryLimits = { raw: 770_000, gzip: 232_000 };
const bootLimits = { raw: 875_000, gzip: 260_000 };
const panelLimits = { raw: 135_000, gzip: 35_000 };
const optionalLimits = { raw: 45_000, gzip: 14_000 };
const nestedLimits = new Map([
  ["RecordDetail", { raw: 50_000, gzip: 16_000 }],
]);
const totalShellLimits = { raw: 980_000, gzip: 290_000 };

await check("static entry closure", analysis.entryClosure.files, entryLimits);

const panelChunk = analysis.lazyChunks.find(
  chunk => chunk.label === panelBoundary.label,
);
if (!panelChunk) {
  throw new Error(`bundle manifest: missing ${panelBoundary.label} analysis`);
}
await check(
  `boot-critical entry + ${panelBoundary.label}`,
  mergeFiles(analysis.entryClosure.files, panelChunk.closure.files),
  bootLimits,
);
await check(`${panelBoundary.label} lazy closure`, panelChunk.closure.files, panelLimits);

for (const chunk of analysis.lazyChunks) {
  if (chunk === panelChunk) continue;
  await check(
    `${chunk.label} lazy closure`, chunk.closure.files,
    nestedLimits.get(chunk.label) ?? optionalLimits,
  );
}

await check(
  "total shell JavaScript",
  analysis.totalShellJsFiles,
  totalShellLimits,
);

const assetNames = await readdir(join(distRoot, "assets"));
function oneAsset(pattern, label) {
  const matches = assetNames.filter(name => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one matching asset, found ${matches.length}`);
  }
  return `assets/${matches[0]}`;
}

const databaseWorkerFile = oneAsset(/^db-worker-[^.]+\.js$/, "database worker");
await check(
  "database worker",
  [databaseWorkerFile],
  { raw: 765_000, gzip: 220_000 },
);

const sqliteSupportFiles = [
  oneAsset(/^sqlite3-worker1-[^.]+\.js$/, "SQLite worker"),
  oneAsset(/^sqlite3-opfs-async-proxy-[^.]+\.js$/, "SQLite OPFS proxy"),
];
await check("SQLite support workers", sqliteSupportFiles,
  { raw: 270_000, gzip: 90_000 });
const wasmFile = oneAsset(/^sqlite3-[^.]+\.wasm$/, "SQLite WASM");
await check("SQLite WASM", [wasmFile], { raw: 900_000, gzip: 420_000 });
const panelRuntimeFile = "panel-runtime.iife.js";
const panelRuntimeMeasured = await checkAt(panelRuntimeRoot,
  "sandbox panel bootstrap", [panelRuntimeFile],
  { raw: 82_000, gzip: 21_000 });

const cssFiles = mergeFiles(
  ...Object.values(manifest).map(record => [
    ...(record.file?.endsWith(".css") ? [record.file] : []),
    ...(record.css ?? []),
  ]),
);
if (cssFiles.length === 0) {
  throw new Error("application styles: expected at least one CSS asset, found 0");
}
await check(
  "application styles",
  cssFiles,
  { raw: 82_000, gzip: 17_000 },
);

const browserRuntimeMeasured = await measureFiles(distRoot,
  mergeFiles(analysis.totalShellJsFiles, [databaseWorkerFile], sqliteSupportFiles,
    [wasmFile], cssFiles));
printAndAssert("complete browser runtime payload", {
  files: [...browserRuntimeMeasured.files, ...panelRuntimeMeasured.files],
  raw: browserRuntimeMeasured.raw + panelRuntimeMeasured.raw,
  gzip: browserRuntimeMeasured.gzip + panelRuntimeMeasured.gzip,
}, { raw: 3_020_000, gzip: 1_035_000 });

console.log("BUNDLE BUDGET GREEN");
