import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertTestOrigin, rejectExternalBrowser, markOwnedContext, assertOwnedPage } from "../p0-browser-safety.mjs";

rejectExternalBrowser(process.env);

const fixtureDir = new URL("./", import.meta.url);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const outDir = new URL("../../evidence/production-authority-browser/", import.meta.url);
const reportFile = new URL("report.json", outDir);
const port = Number.parseInt(process.env.PORT || "4181", 10);
let server = null;
let serverOutput = "";
let url = process.env.URL;

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
  canonicalState: new URL("../../packages/kernel/src/canonical-state.ts", fixtureDir),
  coordinator: new URL("../../packages/kernel/src/production-mutation-coordinator.ts", fixtureDir),
  importAuthority: new URL("../../packages/kernel/src/production-import.ts", fixtureDir),
  requestJournal: new URL("../../packages/kernel/src/production-request-journal.ts", fixtureDir),
  store: new URL("../../packages/kernel/src/store.ts", fixtureDir),
  db: new URL("../../packages/kernel/src/db.ts", fixtureDir),
  inventory: new URL("../../packages/kernel/src/durable-inventory.ts", fixtureDir),
  targetAuthority: new URL("../../packages/kernel/src/target-authority.ts", fixtureDir),
  merkle: new URL("../../packages/kernel/src/state-merkle-index.ts", fixtureDir),
  shellApp: new URL("../../packages/shell/src/app/App.tsx", fixtureDir),
  shellSwitcher: new URL("../../packages/shell/src/app/AppSwitcher.tsx", fixtureDir),
  shellApps: new URL("../../packages/shell/src/app/apps.ts", fixtureDir),
  shellClient: new URL("../../packages/shell/src/app/worker-client.ts", fixtureDir),
  shellImport: new URL("../../packages/shell/src/app/new-app-import.ts", fixtureDir),
  shellWorker: new URL("../../packages/shell/src/worker/db-worker.ts", fixtureDir),
  routeCensus: new URL("../../packages/shell/src/worker/mutation-route-census.ts", fixtureDir),
  lockfile: new URL("../../pnpm-lock.yaml", fixtureDir),
};

const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = async () => Object.fromEntries(await Promise.all(Object.entries(sources)
  .map(async ([name, file]) => [name, hashBytes(await readFile(file))])));
const fingerprint = hashes => hashBytes(Buffer.from(JSON.stringify(hashes)));
const git = args => execFileSync("git", args, {
  cwd: projectRoot,
  encoding: "utf8",
  windowsHide: true,
}).trim();

await mkdir(outDir, { recursive: true });
const baseHead = git(["rev-parse", "HEAD"]);
const sourceSha256 = await sourceHashes();
const testedSourceFingerprint = fingerprint(sourceSha256);
await writeFile(reportFile, JSON.stringify({
  schema: 2,
  verdict: "INVALIDATED",
  status: "RUNNING",
  baseHead,
  testedSourceFingerprint,
}, null, 2));

if (!url) {
  const vite = fileURLToPath(new URL(
    "../../packages/shell/node_modules/vite/bin/vite.js", import.meta.url,
  ));
  server = spawn(process.execPath, [vite, fileURLToPath(fixtureDir),
    "--config", fileURLToPath(new URL("vite.config.mjs", fixtureDir)),
    "--configLoader", "runner", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", chunk => { serverOutput += String(chunk); });
  server.stderr.on("data", chunk => { serverOutput += String(chunk); });
  url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) break;
    if (!serverOutput.includes(`127.0.0.1:${port}`)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* retry startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`authority evidence server did not start: ${serverOutput}`);
}
process.on("exit", () => { try { server?.kill(); } catch { /* stopped */ } });

assertTestOrigin(url);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", chromiumSandbox: true });
const context = await browser.newContext();
await markOwnedContext(context);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", error => consoleErrors.push(error.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
const invoke = async payload => {
  await assertOwnedPage(page);
  return page.evaluate(input => window.authorityRun(input), payload);
};
const rejectedMessage = async payload => {
  try {
    await invoke(payload);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const req = character => `req_${character.repeat(26)}`;
const failures = [];
const requiredCases = [
  "sourceBytesStable",
  "emptyCatalogAttachmentRecovery",
  "legacyNamespacesAdoptedWithoutReplacement",
  "interruptedAdoptionResume",
  "authoritySwitchAndRequestReplay",
  "localCacheIsProjectionOnly",
  "staleTabCannotDeleteUnselectedApp",
  "forkCopiesDataHistoryPanelsAndIdentity",
  "forkHasIndependentWrites",
  "renameSurvivesReload",
  "createRequestReplayHasSingleTarget",
  "crossKindRequestReuseDenied",
  "newAppImportDurableReadback",
  "newAppImportRequestReplay",
  "newAppImportBoundedUndo",
  "deterministicDeleteAndReplay",
  "declaredPartialTargetCrashResume",
  "tombstoneCleanupCrashResume",
  "lastAppDeleteDenied",
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

const evidence = {};
try {
  await invoke({ op: "reset" });
  evidence.emptySeeded = await invoke({ op: "seed" });
  evidence.emptyCatalog = await invoke({ op: "leaveEmptyCatalog" });
  evidence.emptyRecovered = await invoke({ op: "boot", requestedAppId: "field" });
  certify("emptyCatalogAttachmentRecovery",
    evidence.emptyCatalog.catalogPresent && evidence.emptyRecovered.boot.apps.length === 2
      && evidence.emptyRecovered.rows[0]?.name === "Field row",
    `empty catalog recovery mismatch: ${JSON.stringify(evidence.emptyRecovered)}`);

  await invoke({ op: "reset" });
  evidence.seeded = await invoke({ op: "seed" });
  const legacyFiles = sorted(evidence.seeded.fileNames);
  const legacyInventory = evidence.seeded.inventory;
  if (legacyInventory.state !== "complete" || legacyInventory.catalogPresent
      || legacyInventory.namespaces.length !== 2)
    throw new Error(`legacy fixture inventory mismatch: ${JSON.stringify(evidence.seeded)}`);

  evidence.partial = await invoke({ op: "partial" });
  evidence.resumed = await invoke({ op: "boot", requestedAppId: "field" });
  certify("interruptedAdoptionResume",
    evidence.partial.remaining === 1 && evidence.partial.entries === 1
      && evidence.resumed.boot.apps.length === 2
      && evidence.resumed.rows[0]?.name === "Field row",
    `adoption resume mismatch: ${JSON.stringify({ partial: evidence.partial, resumed: evidence.resumed })}`);
  certify("legacyNamespacesAdoptedWithoutReplacement",
    legacyInventory.namespaces.every(before => evidence.resumed.inventory.namespaces.some(after =>
      same(before, after)))
      && legacyFiles.every(file => evidence.resumed.fileNames.includes(file))
      && evidence.resumed.inventory.namespaces.length === 2,
    `legacy physical identity changed: ${JSON.stringify({ seeded: evidence.seeded, resumed: evidence.resumed })}`);

  const projects = evidence.resumed.boot.apps.find(app => app.name === "Projects");
  const field = evidence.resumed.boot.apps.find(app => app.name === "Field Service");
  if (!projects || !field) throw new Error("adopted source apps are incomplete");
  evidence.switched = await invoke({
    op: "lifecycle", kind: "switch", requestId: req("a"), appInstanceId: projects.id,
  });
  evidence.switchReplay = await invoke({
    op: "lifecycle", kind: "switch", requestId: req("a"), appInstanceId: projects.id,
  });
  certify("authoritySwitchAndRequestReplay",
    evidence.switched.boot.selectedAppInstanceId === projects.id
      && evidence.switched.rows[0]?.name === "Projects row"
      && same(evidence.switched.evidence.target, evidence.switchReplay.evidence.target)
      && evidence.switchReplay.boot.apps.length === 2,
    `switch/replay mismatch: ${JSON.stringify({ switched: evidence.switched, replay: evidence.switchReplay })}`);

  evidence.staleHint = await invoke({ op: "boot", requestedAppId: field.id });
  certify("localCacheIsProjectionOnly",
    evidence.staleHint.boot.selectedAppInstanceId === projects.id,
    `presentation cache hint overrode catalog selection: ${JSON.stringify(evidence.staleHint)}`);
  evidence.staleDeleteError = await rejectedMessage({
    op: "lifecycle", kind: "delete", requestId: req("q"), appInstanceId: field.id,
  });
  certify("staleTabCannotDeleteUnselectedApp",
    /selected app/i.test(evidence.staleDeleteError ?? "")
      && (await invoke({ op: "inspect" })).catalog.entries.length === 2,
    `stale deletion was not rejected: ${evidence.staleDeleteError}`);

  const sourceTargetBeforeFork = evidence.switched.evidence.target;
  const sourceHistoryBeforeFork = evidence.switched.history;
  const sourcePanelsBeforeFork = evidence.switched.panels;
  evidence.forked = await invoke({
    op: "lifecycle", kind: "fork", requestId: req("b"),
  });
  const forkId = evidence.forked.boot.selectedAppInstanceId;
  const forkEntry = evidence.forked.evidence.catalog.entries.find(app => app.appInstanceId === forkId);
  const retainedSource = evidence.forked.evidence.catalog.entries.find(app => app.appInstanceId === projects.id);
  certify("forkCopiesDataHistoryPanelsAndIdentity",
    forkId !== projects.id
      && forkEntry?.activeGenerationId !== sourceTargetBeforeFork.activeGenerationId
      && evidence.forked.inventory.namespaces.length === 3
      && evidence.forked.rows[0]?.name === "Projects row"
      && same(evidence.forked.history, sourceHistoryBeforeFork)
      && same(evidence.forked.panels, sourcePanelsBeforeFork)
      && same(targetFromEntry(retainedSource), sourceTargetBeforeFork),
    `fork copy mismatch: ${JSON.stringify({ sourceTargetBeforeFork, retainedSource, forked: evidence.forked })}`);

  evidence.forkWrite = await invoke({
    op: "insertRecord", requestId: req("c"), name: "Fork-only row",
  });
  evidence.sourceAfterFork = await invoke({
    op: "lifecycle", kind: "switch", requestId: req("d"), appInstanceId: projects.id,
  });
  evidence.returnedToFork = await invoke({
    op: "lifecycle", kind: "switch", requestId: req("e"), appInstanceId: forkId,
  });
  certify("forkHasIndependentWrites",
    evidence.forkWrite.rows.length === 2
      && evidence.sourceAfterFork.rows.length === 1
      && evidence.sourceAfterFork.rows[0]?.name === "Projects row"
      && same(evidence.sourceAfterFork.evidence.target, sourceTargetBeforeFork)
      && evidence.returnedToFork.rows.length === 2,
    `fork independence mismatch: ${JSON.stringify({ forkWrite: evidence.forkWrite, source: evidence.sourceAfterFork, returned: evidence.returnedToFork })}`);

  evidence.renamed = await invoke({
    op: "lifecycle", kind: "rename", requestId: req("f"),
    appInstanceId: forkId, displayName: "Projects Explorer", shellId: null,
  });
  evidence.renameReload = await invoke({ op: "boot", requestedAppId: projects.id });
  certify("renameSurvivesReload",
    evidence.renamed.boot.apps.find(app => app.id === forkId)?.name === "Projects Explorer"
      && evidence.renameReload.boot.selectedAppInstanceId === forkId
      && evidence.renameReload.boot.apps.find(app => app.id === forkId)?.name === "Projects Explorer"
      && evidence.renameReload.rows.length === 2,
    `rename readback mismatch: ${JSON.stringify({ renamed: evidence.renamed, reload: evidence.renameReload })}`);

  evidence.created = await invoke({
    op: "lifecycle", kind: "create", requestId: req("g"),
    displayName: "Imported Expenses", shellId: "blank",
  });
  const createdId = evidence.created.boot.selectedAppInstanceId;
  evidence.createReplay = await invoke({
    op: "lifecycle", kind: "create", requestId: req("g"),
    displayName: "Imported Expenses", shellId: "blank",
  });
  certify("createRequestReplayHasSingleTarget",
    evidence.created.boot.apps.length === 4
      && evidence.createReplay.boot.apps.length === 4
      && evidence.createReplay.boot.selectedAppInstanceId === createdId
      && same(evidence.created.inventory, evidence.createReplay.inventory),
    `create retry duplicated a target: ${JSON.stringify({ created: evidence.created, replay: evidence.createReplay })}`);
  evidence.crossKindError = await rejectedMessage({
    op: "lifecycle", kind: "fork", requestId: req("g"),
  });
  certify("crossKindRequestReuseDenied", /reused/i.test(evidence.crossKindError ?? ""),
    `cross-kind reuse was not denied: ${evidence.crossKindError}`);

  const importPayload = {
    table: "expenses",
    columns: [{ name: "item", type: "text" }, { name: "amount", type: "number" }],
    rows: [{ item: "Coffee", amount: 4.5 }, { item: "Rent", amount: 1200 }],
  };
  evidence.imported = await invoke({
    op: "importNewApp", createRequestId: req("g"), requestId: req("h"),
    payload: importPayload,
  });
  evidence.importReplay = await invoke({
    op: "importNewApp", createRequestId: req("g"), requestId: req("h"),
    payload: importPayload,
  });
  certify("newAppImportDurableReadback",
    evidence.imported.result.appInstanceId === createdId
      && evidence.imported.result.imported === 2
      && evidence.imported.data.expenses?.length === 2
      && evidence.imported.history.length === 1
      && evidence.imported.panels.some(panel => panel.declared_queries.some(query => query.from === "expenses")),
    `new-app import readback mismatch: ${JSON.stringify(evidence.imported)}`);
  certify("newAppImportRequestReplay",
    same(evidence.imported.result, evidence.importReplay.result)
      && evidence.importReplay.data.expenses?.length === 2
      && evidence.importReplay.history.length === 1,
    `new-app import replay mismatch: ${JSON.stringify(evidence.importReplay)}`);

  evidence.importUndo = await invoke({
    op: "undoNewAppImport", createRequestId: req("g"),
    importRequestId: req("h"), requestId: req("i"),
  });
  evidence.importUndoReplay = await invoke({
    op: "undoNewAppImport", createRequestId: req("g"),
    importRequestId: req("h"), requestId: req("i"),
  });
  certify("newAppImportBoundedUndo",
    evidence.importUndo.result.undone === true
      && evidence.importUndo.tables.length === 0
      && evidence.importUndo.panels.length === 0
      && evidence.importUndo.history.length === 0
      && same(evidence.importUndo.result, evidence.importUndoReplay.result),
    `new-app import Undo mismatch: ${JSON.stringify({ undo: evidence.importUndo, replay: evidence.importUndoReplay })}`);

  const expectedFallback = sorted(evidence.importUndo.boot.apps
    .filter(app => app.id !== createdId).map(app => app.id))[0];
  evidence.deleted = await invoke({
    op: "lifecycle", kind: "delete", requestId: req("j"), appInstanceId: createdId,
  });
  evidence.deleteReplay = await invoke({
    op: "lifecycle", kind: "delete", requestId: req("j"), appInstanceId: createdId,
  });
  certify("deterministicDeleteAndReplay",
    evidence.deleted.boot.selectedAppInstanceId === expectedFallback
      && !evidence.deleted.boot.apps.some(app => app.id === createdId)
      && evidence.deleted.inventory.namespaces.length === 3
      && same(evidence.deleted.inventory, evidence.deleteReplay.inventory),
    `delete/replay mismatch: ${JSON.stringify({ expectedFallback, deleted: evidence.deleted, replay: evidence.deleteReplay })}`);

  evidence.pendingCreate = await invoke({ op: "declarePendingCreate", requestId: req("k") });
  evidence.partialPendingTarget = await invoke({
    op: "materializePendingTarget", target: evidence.pendingCreate.job.target,
  });
  evidence.recoveredCreate = await invoke({ op: "boot", requestedAppId: null });
  evidence.recoveredCreateState = await invoke({ op: "inspect" });
  certify("declaredPartialTargetCrashResume",
    evidence.pendingCreate.job.kind === "create"
      && evidence.partialPendingTarget.inventory.namespaces.some(item =>
        item.storageKey === evidence.pendingCreate.job.target.storageKey)
      && evidence.recoveredCreate.boot.selectedAppInstanceId
        === evidence.pendingCreate.job.target.appInstanceId
      && evidence.recoveredCreateState.lifecycleJobs.length === 0
      && evidence.recoveredCreateState.inventory.namespaces.length === 4,
    `pending target recovery mismatch: ${JSON.stringify({ pending: evidence.pendingCreate, partial: evidence.partialPendingTarget, recovered: evidence.recoveredCreate, state: evidence.recoveredCreateState })}`);

  evidence.pendingDelete = await invoke({ op: "declarePendingDelete", requestId: req("l") });
  const cleanupTarget = evidence.pendingDelete.deleted.cleanupJob.target;
  evidence.recoveredDelete = await invoke({ op: "boot", requestedAppId: null });
  evidence.recoveredDeleteState = await invoke({ op: "inspect" });
  certify("tombstoneCleanupCrashResume",
    evidence.pendingDelete.deleted.cleanupJob.kind === "cleanup"
      && evidence.pendingDelete.inventory.namespaces.some(item => item.storageKey === cleanupTarget.storageKey)
      && evidence.recoveredDeleteState.lifecycleJobs.length === 0
      && !evidence.recoveredDeleteState.inventory.namespaces.some(item =>
        item.storageKey === cleanupTarget.storageKey)
      && !evidence.recoveredDeleteState.fileNames.includes(cleanupTarget.userFile)
      && !evidence.recoveredDeleteState.fileNames.includes(cleanupTarget.systemFile),
    `pending cleanup recovery mismatch: ${JSON.stringify({ pending: evidence.pendingDelete, recovered: evidence.recoveredDelete, state: evidence.recoveredDeleteState })}`);

  let reduced = evidence.recoveredDelete;
  const cleanupRequestIds = [req("m"), req("n")];
  for (const requestId of cleanupRequestIds) {
    if (reduced.boot.apps.length <= 1) break;
    reduced = await invoke({
      op: "lifecycle", kind: "delete", requestId,
      appInstanceId: reduced.boot.selectedAppInstanceId,
    });
  }
  evidence.singleApp = reduced;
  evidence.lastDeleteError = await rejectedMessage({
    op: "lifecycle", kind: "delete", requestId: req("o"),
    appInstanceId: reduced.boot.selectedAppInstanceId,
  });
  certify("lastAppDeleteDenied",
    reduced.boot.apps.length === 1 && /last|delete/i.test(evidence.lastDeleteError ?? ""),
    `last app deletion was not denied: ${evidence.lastDeleteError}`);

  evidence.final = await invoke({ op: "inspect" });
  certify("exactDurableInventory",
    evidence.final.manifest.length === 0 && evidence.final.catalog.entries.length === 1
      && evidence.final.activeStorage.length === 1 && inventoryIsExact(evidence.final),
    `final inventory mismatch: ${JSON.stringify(evidence.final)}`);
} catch (error) {
  failures.push(`journey aborted: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
}

const endingSourceSha256 = await sourceHashes();
const endingSourceFingerprint = fingerprint(endingSourceSha256);
certify("sourceBytesStable",
  testedSourceFingerprint === endingSourceFingerprint && same(sourceSha256, endingSourceSha256),
  `source changed during run: ${testedSourceFingerprint} -> ${endingSourceFingerprint}`);

const valid = failures.length === 0 && consoleErrors.length === 0
  && requiredCases.every(name => cases[name] === true);
const report = {
  schema: 2,
  verdict: valid ? "PRODUCTION_MULTI_APP_P0_VALIDATED" : "INVALIDATED",
  releaseCertificate: false,
  generatedAt: new Date().toISOString(),
  browser: await browser.version(),
  baseHead,
  testedSourceFingerprint,
  endingSourceFingerprint,
  sourceSha256,
  cases,
  evidence,
  failures,
  consoleErrors,
  limitations: [
    "This authority harness is Chromium OPFS evidence; the packaged application UI is certified separately.",
    "Injected crashes occur at committed catalog/physical phase boundaries, not inside native SQLite COMMIT.",
    "The tested tree is dirty by mission design, so hashes bind exact source bytes but are not an immutable Git tree.",
    "This is the multi-app P0 slice only and is not a Release B or full-roadmap certificate.",
  ],
};
await writeFile(reportFile, JSON.stringify(report, null, 2));
await browser.close();
if (server) server.kill();
console.log(JSON.stringify({
  verdict: report.verdict,
  releaseCertificate: report.releaseCertificate,
  baseHead: report.baseHead,
  testedSourceFingerprint: report.testedSourceFingerprint,
  cases: report.cases,
  failures: report.failures,
  consoleErrors: report.consoleErrors,
  report: "evidence/production-authority-browser/report.json",
}));
if (!valid) process.exit(1);
