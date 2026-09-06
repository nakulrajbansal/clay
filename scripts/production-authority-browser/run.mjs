import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureDir = new URL("./", import.meta.url);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const outDir = new URL("../../evidence/production-authority-browser/", import.meta.url);
const reportFile = new URL("report.json", outDir);
const allowedDirtyPath = "evidence/production-authority-browser/report.json";
const port = Number.parseInt(process.env.PORT || "4177", 10);
let server = null;
let serverOutput = "";
let url = process.env.URL;

function gitLines(args) {
  const output = execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return output === "" ? [] : output.split(/\r?\n/);
}

function frozenSourceTree() {
  const unstaged = gitLines(["diff", "--name-only", "--"])
    .filter(path => path !== allowedDirtyPath);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  if (unstaged.length !== 0 || untracked.length !== 0) {
    throw new Error(
      `lifecycle evidence source is not frozen: ${[...unstaged, ...untracked].join(", ")}`,
    );
  }
  const tree = gitLines(["write-tree"])[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("lifecycle evidence source tree is invalid");
  return tree;
}

await mkdir(outDir, { recursive: true });
const testedSourceTree = frozenSourceTree();
await writeFile(reportFile, JSON.stringify({
  schema: 1,
  verdict: "INVALIDATED",
  status: "RUNNING",
  testedSourceTree,
}, null, 2));

if (!url) {
  const vite = fileURLToPath(new URL(
    "../../packages/shell/node_modules/vite/bin/vite.js", import.meta.url,
  ));
  server = spawn(process.execPath, [vite, fileURLToPath(fixtureDir),
    "--config", fileURLToPath(new URL("vite.config.mjs", fixtureDir)),
    "--configLoader", "runner", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLAY_TESTED_SOURCE_TREE: testedSourceTree },
  });
  server.stdout.on("data", chunk => { serverOutput += String(chunk); });
  server.stderr.on("data", chunk => { serverOutput += String(chunk); });
  url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) break;
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`authority evidence server did not start: ${serverOutput}`);
}
process.on("exit", () => { try { server?.kill(); } catch { /* stopped */ } });

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", error => errors.push(error.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
const renderedSourceTree = await page.evaluate(() =>
  document.documentElement.dataset.claySourceTree ?? null);
const invoke = payload => page.evaluate(input => window.authorityRun(input), payload);
const failures = [];
const requiredCases = [
  "sourceTreeBound",
  "emptyCatalogAttachmentRecovery",
  "twoLegacyNamespaces",
  "interruptedAfterOneAtomicAdoption",
  "freshWorkerResume",
  "catalogCanonicalSwitch",
  "localCacheIsProjectionOnly",
  "canonicalForkWithoutSourceMutation",
  "workerOwnedCreate",
  "workerOwnedRename",
  "deterministicDeleteFallback",
  "freshGenerationReset",
  "declaredPartialTargetCrashResume",
  "tombstoneCleanupCrashResume",
  "exactDurableInventory",
];
const cases = Object.fromEntries(requiredCases.map(name => [name, false]));
function certify(name, condition, detail) {
  cases[name] = Boolean(condition);
  if (!condition) failures.push(`${name}: ${detail}`);
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = values => [...values].sort((left, right) => left.localeCompare(right));
const targetFromEntry = entry => entry ? ({
  appInstanceId: entry.appInstanceId,
  activeGenerationId: entry.activeGenerationId,
  lineageEpoch: entry.currentLineageEpoch,
  protectionRevision: entry.currentProtectionRevision,
  digestSchema: entry.digestSchema,
  stateSha256: entry.stateSha256,
}) : null;
const physicalFromActive = item => item.storageKey === item.namespaceId ? ({
  storageKey: item.storageKey,
  userFile: `/${item.storageKey}-user.db`,
  systemFile: `/${item.storageKey}-system.db`,
  kind: "generation",
}) : item.storageKey === "default" ? ({
  storageKey: item.storageKey,
  userFile: "/user.db",
  systemFile: "/system.db",
  kind: "legacy",
}) : ({
  storageKey: item.storageKey,
  userFile: `/app-${item.storageKey}-user.db`,
  systemFile: `/app-${item.storageKey}-system.db`,
  kind: "legacy",
});
function inventoryIsExact(state) {
  if (!state || state.inventory?.state !== "complete" || !state.inventory.catalogPresent
      || !Array.isArray(state.activeStorage) || !Array.isArray(state.fileNames)) return false;
  const expectedNamespaces = state.activeStorage.map(physicalFromActive)
    .sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  const observedNamespaces = [...state.inventory.namespaces]
    .sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  const expectedFiles = sorted([
    "/clay-device-catalog-v1.db",
    ...expectedNamespaces.flatMap(item => [item.userFile, item.systemFile]),
  ]);
  return same(observedNamespaces, expectedNamespaces)
    && same(sorted(state.fileNames), expectedFiles)
    && state.catalog.entries.length === expectedNamespaces.length;
}

let emptySeeded = null;
let emptyCatalog = null;
let emptyRecovered = null;
let seeded = null;
let partial = null;
let resumed = null;
let switched = null;
let forked = null;
let sourceAfterFork = null;
let returnedToFork = null;
let renamed = null;
let created = null;
let deleted = null;
let resetApp = null;
let pendingCreate = null;
let partialPendingTarget = null;
let recoveredCreate = null;
let recoveredCreateState = null;
let pendingDelete = null;
let recoveredDelete = null;
let recoveredDeleteState = null;
let final = null;

try {
  await invoke({ op: "reset" });
  emptySeeded = await invoke({ op: "seed" });
  emptyCatalog = await invoke({ op: "leaveEmptyCatalog" });
  emptyRecovered = await invoke({ op: "boot", requestedAppId: "field" });
  certify("emptyCatalogAttachmentRecovery",
    emptyCatalog.catalogPresent && emptyRecovered.boot.apps.length === 2
      && emptyRecovered.rows[0]?.name === "Field row",
    `empty catalog recovery mismatch: ${JSON.stringify(emptyRecovered)}`);

  await invoke({ op: "reset" });
  seeded = await invoke({ op: "seed" });
  certify("twoLegacyNamespaces",
    seeded.state === "complete" && !seeded.catalogPresent && seeded.namespaces.length === 2,
    `legacy fixture inventory mismatch: ${JSON.stringify(seeded)}`);

  partial = await invoke({ op: "partial" });
  certify("interruptedAfterOneAtomicAdoption",
    partial.remaining === 1 && partial.entries === 1 && partial.selectedStorageKey !== "field",
    `partial bootstrap mismatch: ${JSON.stringify(partial)}`);

  resumed = await invoke({ op: "boot", requestedAppId: "field" });
  certify("freshWorkerResume",
    resumed.boot.apps.length === 2
      && resumed.boot.apps.find(app => app.id === resumed.boot.selectedAppInstanceId)?.name
        === "Field Service"
      && resumed.rows.length === 1 && resumed.rows[0]?.name === "Field row",
    `resumed selected target mismatch: ${JSON.stringify(resumed)}`);

  const projects = resumed.boot.apps.find(app => app.name === "Projects");
  if (!projects) throw new Error("canonical Projects app is missing");
  switched = await invoke({ op: "lifecycle", kind: "switch", appInstanceId: projects.id });
  certify("catalogCanonicalSwitch",
    switched.boot.selectedAppInstanceId === projects.id
      && switched.rows.length === 1 && switched.rows[0]?.name === "Projects row",
    `catalog switch mismatch: ${JSON.stringify(switched)}`);

  const staleHint = await invoke({
    op: "boot",
    requestedAppId: resumed.boot.selectedAppInstanceId,
  });
  certify("localCacheIsProjectionOnly",
    staleHint.boot.selectedAppInstanceId === projects.id,
    `local cache hint overrode durable selection: ${JSON.stringify(staleHint)}`);

  const sourceTargetBeforeFork = switched.evidence.target;
  forked = await invoke({ op: "lifecycle", kind: "fork" });
  const forkId = forked.boot.selectedAppInstanceId;
  const retainedSourceEntry = forked.evidence.catalog.entries.find(app => app.appInstanceId === projects.id);
  sourceAfterFork = await invoke({
    op: "lifecycle", kind: "switch", appInstanceId: projects.id,
  });
  certify("canonicalForkWithoutSourceMutation",
    forked.boot.apps.length === 3 && forkId !== projects.id
      && forked.rows.length === 1 && forked.rows[0]?.name === "Projects row"
      && forked.inventory.namespaces.length === 3
      && same(targetFromEntry(retainedSourceEntry), sourceTargetBeforeFork)
      && same(sourceAfterFork.evidence.target, sourceTargetBeforeFork)
      && sourceAfterFork.rows.length === 1 && sourceAfterFork.rows[0]?.name === "Projects row",
    `fork changed its original target: ${JSON.stringify({
      sourceTargetBeforeFork, retainedSourceEntry, sourceAfterFork, forked,
    })}`);

  returnedToFork = await invoke({ op: "lifecycle", kind: "switch", appInstanceId: forkId });
  renamed = await invoke({
    op: "lifecycle", kind: "rename",
    appInstanceId: forkId,
    displayName: "Projects Explorer",
    shellId: null,
  });
  certify("workerOwnedRename",
    renamed.boot.apps.find(app => app.id === forkId)?.name === "Projects Explorer",
    `rename lifecycle mismatch: ${JSON.stringify(renamed)}`);

  created = await invoke({
    op: "lifecycle", kind: "create", displayName: "Scratch", shellId: "blank",
  });
  const createdId = created.boot.selectedAppInstanceId;
  certify("workerOwnedCreate",
    created.boot.apps.length === 4 && created.rows.length === 0
      && created.inventory.namespaces.length === 4,
    `create lifecycle mismatch: ${JSON.stringify(created)}`);

  const expectedFallback = sorted(created.boot.apps
    .filter(app => app.id !== createdId).map(app => app.id))[0];
  deleted = await invoke({ op: "lifecycle", kind: "delete", appInstanceId: createdId });
  certify("deterministicDeleteFallback",
    deleted.boot.apps.length === 3 && !deleted.boot.apps.some(app => app.id === createdId)
      && deleted.boot.selectedAppInstanceId === expectedFallback
      && deleted.inventory.namespaces.length === 3,
    `delete fallback mismatch: ${JSON.stringify({ expectedFallback, deleted })}`);

  const resetSourceId = deleted.boot.selectedAppInstanceId;
  resetApp = await invoke({ op: "lifecycle", kind: "reset" });
  certify("freshGenerationReset",
    resetApp.boot.apps.length === 3 && resetApp.boot.selectedAppInstanceId !== resetSourceId
      && !resetApp.boot.apps.some(app => app.id === resetSourceId)
      && resetApp.rows.length === 0 && resetApp.inventory.namespaces.length === 3,
    `reset lifecycle mismatch: ${JSON.stringify(resetApp)}`);

  pendingCreate = await invoke({ op: "declarePendingCreate" });
  const pendingWasAbsent = pendingCreate.job.kind === "create"
    && pendingCreate.inventory.namespaces.length === 3
    && !pendingCreate.inventory.namespaces.some(item =>
      item.storageKey === pendingCreate.job.target.storageKey);
  partialPendingTarget = await invoke({
    op: "materializePendingTarget",
    target: pendingCreate.job.target,
  });
  const partialWasPresent = partialPendingTarget.inventory.state === "complete"
    && partialPendingTarget.inventory.namespaces.some(item =>
      item.storageKey === pendingCreate.job.target.storageKey)
    && partialPendingTarget.fileNames.includes(pendingCreate.job.target.userFile)
    && partialPendingTarget.fileNames.includes(pendingCreate.job.target.systemFile);
  recoveredCreate = await invoke({ op: "boot", requestedAppId: null });
  recoveredCreateState = await invoke({ op: "inspect" });
  certify("declaredPartialTargetCrashResume",
    pendingWasAbsent && partialWasPresent
      && recoveredCreate.boot.selectedAppInstanceId === pendingCreate.job.target.appInstanceId
      && recoveredCreate.boot.apps.length === 4 && recoveredCreate.rows.length === 0
      && recoveredCreateState.lifecycleJobs.length === 0
      && recoveredCreateState.inventory.namespaces.length === 4,
    `pending target recovery mismatch: ${JSON.stringify({
      pendingCreate, partialPendingTarget, recoveredCreate, recoveredCreateState,
    })}`);

  pendingDelete = await invoke({ op: "declarePendingDelete" });
  const cleanupTarget = pendingDelete.deleted.cleanupJob.target;
  const cleanupWasPresent = pendingDelete.deleted.cleanupJob.kind === "cleanup"
    && pendingDelete.inventory.namespaces.some(item => item.storageKey === cleanupTarget.storageKey);
  recoveredDelete = await invoke({ op: "boot", requestedAppId: null });
  recoveredDeleteState = await invoke({ op: "inspect" });
  certify("tombstoneCleanupCrashResume",
    cleanupWasPresent && recoveredDelete.boot.apps.length === 3
      && !recoveredDelete.boot.apps.some(app => app.id === cleanupTarget.appInstanceId)
      && recoveredDeleteState.lifecycleJobs.length === 0
      && !recoveredDeleteState.inventory.namespaces.some(item =>
        item.storageKey === cleanupTarget.storageKey)
      && !recoveredDeleteState.fileNames.includes(cleanupTarget.userFile)
      && !recoveredDeleteState.fileNames.includes(cleanupTarget.systemFile),
    `pending cleanup recovery mismatch: ${JSON.stringify({
      pendingDelete, recoveredDelete, recoveredDeleteState,
    })}`);

  final = recoveredDeleteState;
  certify("exactDurableInventory",
    final.manifest.length === 0 && final.catalog.entries.length === 3
      && final.activeStorage.length === 3 && inventoryIsExact(final),
    `final inventory mismatch: ${JSON.stringify(final)}`);
} catch (error) {
  failures.push(`journey aborted: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
}

let sourceTreeAfterRun = null;
try { sourceTreeAfterRun = frozenSourceTree(); }
catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
certify("sourceTreeBound",
  renderedSourceTree === testedSourceTree && sourceTreeAfterRun === testedSourceTree,
  `expected ${testedSourceTree}, rendered ${renderedSourceTree}, after ${sourceTreeAfterRun}`);

const hash = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const sources = {
  runner: new URL("run.mjs", fixtureDir),
  controller: new URL("index.html", fixtureDir),
  viteConfig: new URL("vite.config.mjs", fixtureDir),
  worker: new URL("worker.ts", fixtureDir),
  schemaCatalog: new URL("../../packages/schema/src/catalog.ts", fixtureDir),
  generationCopy: new URL("../../packages/kernel/src/app-generation.ts", fixtureDir),
  lifecycleRequest: new URL("../../packages/kernel/src/app-lifecycle-request.ts", fixtureDir),
  lifecycle: new URL("../../packages/kernel/src/production-app-lifecycle.ts", fixtureDir),
  authority: new URL("../../packages/kernel/src/production-authority.ts", fixtureDir),
  catalog: new URL("../../packages/kernel/src/device-catalog.ts", fixtureDir),
  coordinator: new URL("../../packages/kernel/src/production-mutation-coordinator.ts", fixtureDir),
  requestJournal: new URL("../../packages/kernel/src/production-request-journal.ts", fixtureDir),
  store: new URL("../../packages/kernel/src/store.ts", fixtureDir),
  db: new URL("../../packages/kernel/src/db.ts", fixtureDir),
  inventory: new URL("../../packages/kernel/src/durable-inventory.ts", fixtureDir),
  targetAuthority: new URL("../../packages/kernel/src/target-authority.ts", fixtureDir),
  merkle: new URL("../../packages/kernel/src/state-merkle-index.ts", fixtureDir),
  lockfile: new URL("../../pnpm-lock.yaml", fixtureDir),
};
const sourceSha256 = Object.fromEntries(await Promise.all(Object.entries(sources)
  .map(async ([name, file]) => [name, await hash(file)])));
const valid = failures.length === 0 && errors.length === 0
  && requiredCases.every(name => cases[name] === true);
const report = {
  schema: 1,
  verdict: valid ? "PRODUCTION_LIFECYCLE_SLICE_VALIDATED" : "INVALIDATED",
  releaseCertificate: false,
  generatedAt: new Date().toISOString(),
  browser: await browser.version(),
  testedSourceTree,
  renderedSourceTree,
  sourceTreeAfterRun,
  sourceSha256,
  cases,
  emptySeeded,
  emptyCatalog,
  emptyRecovered,
  seeded,
  partial,
  resumed,
  switched,
  forked,
  sourceAfterFork,
  returnedToFork,
  renamed,
  created,
  deleted,
  resetApp,
  pendingCreate,
  partialPendingTarget,
  recoveredCreate,
  pendingDelete,
  recoveredDelete,
  final,
  failures,
  consoleErrors: errors,
  limitations: [
    "Chromium OPFS only; other durable runtimes remain uncertified.",
    "Injected crashes are process-boundary gaps between committed catalog/physical phases, not during native SQLite COMMIT.",
    "Archive export/import/createImportedApp remain fail-closed and require archive-format-5 authority evidence, staged validation, and worker-owned target reconstruction.",
    "This is a production-browser lifecycle slice, not a Release B certificate.",
  ],
};
await writeFile(reportFile, JSON.stringify(report, null, 2));
await browser.close();
if (server) server.kill();
console.log(JSON.stringify({
  verdict: report.verdict,
  releaseCertificate: report.releaseCertificate,
  testedSourceTree: report.testedSourceTree,
  cases: report.cases,
  failures: report.failures,
  consoleErrors: report.consoleErrors,
  report: "evidence/production-authority-browser/report.json",
}));
if (!valid) process.exit(1);
